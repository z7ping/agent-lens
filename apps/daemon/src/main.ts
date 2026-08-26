import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupLocalPlugin } from '@agent-lens/backup-local'
import { capturePolicyPlugin } from '@agent-lens/capture-policy'
import {
  SESSION_SUMMARY_PROJECTION_ID,
  sessionSummaryProjectionPlugin,
} from '@agent-lens/projection-session'
import {
  AgentLensApplication,
  coreServicesPlugin,
  discoverRegisteredSourceAssets,
  prepareRegisteredSources,
  startRegisteredSourceCapture,
  syncRegisteredSourceHistory,
  type RegisteredSourceFailure,
} from '@agent-lens/runtime-cordis'
import { claudeSourcePlugin } from '@agent-lens/source-claude'
import { codexSourcePlugin } from '@agent-lens/source-codex'
import { hermesSourcePlugin } from '@agent-lens/source-hermes'
import { openCodeSourcePlugin } from '@agent-lens/source-opencode'
import { piSourcePlugin } from '@agent-lens/source-pi'
import { sqliteStoragePlugin } from '@agent-lens/storage-sqlite'
import {
  DEFAULT_AGENT_LENS_HTTP_PORT,
  httpSurfacePlugin,
} from '@agent-lens/surface-http'
import { webPlugin } from '@agent-lens/web'
import { profiledDshSourcePlugin } from './sources/dsh-profiled.js'

const dbPath = process.env.AGENT_LENS_DB_PATH
  ?? join(homedir(), '.agent-lens', '1.0', 'agent-lens.db')
const vaultPath = process.env.AGENT_LENS_VAULT_PATH
  ?? join(homedir(), '.agent-lens', '1.0', 'vault')
const configuredPort = process.env.AGENT_LENS_PORT
  ? Number(process.env.AGENT_LENS_PORT)
  : DEFAULT_AGENT_LENS_HTTP_PORT
const bundledWebRoot = fileURLToPath(new URL('./web/', import.meta.url))
const workspaceWebRoot = fileURLToPath(new URL('../../../packages/web/dist/', import.meta.url))
const webRoot = process.env.AGENT_LENS_WEB_ROOT
  ?? (existsSync(fileURLToPath(new URL('./web/index.html', import.meta.url))) ? bundledWebRoot : workspaceWebRoot)
const daemonMode = process.env.AGENT_LENS_DAEMON_MODE === 'managed' ? 'managed' : 'foreground'
const interactiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
const startedAt = Date.now()
const INITIAL_BACKGROUND_SYNC_DELAY_MS = 600

const app = new AgentLensApplication()
app.use(sqliteStoragePlugin, { path: dbPath })
app.useRuntime(coreServicesPlugin)
app.useRuntime(sessionSummaryProjectionPlugin)
app.useRuntime(capturePolicyPlugin)
app.use(codexSourcePlugin)
app.use(claudeSourcePlugin)
app.use(piSourcePlugin)
app.use(hermesSourcePlugin)
app.use(openCodeSourcePlugin)
app.use(profiledDshSourcePlugin)
app.useRuntime(backupLocalPlugin, { vaultPath })
app.use(httpSurfacePlugin, { port: configuredPort })
app.use(webPlugin, { staticDir: webRoot })

const runtimeController = new AbortController()
let syncPromise: Promise<void> | null = null
let captureHandles: Awaited<ReturnType<typeof startRegisteredSourceCapture>>['results'] = []
let shuttingDown = false

function runtimeAge(): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  return `${seconds}s`
}

function logSourceFailures(failures: RegisteredSourceFailure[]): void {
  for (const failure of failures) {
    console.error(
      `[AgentLens] source ${failure.stage} failed: ${failure.sourceId}`,
      failure.error,
    )
  }
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  runtimeController.abort()

  try {
    if (syncPromise) await syncPromise.catch(() => undefined)
    for (const handle of [...captureHandles].reverse()) {
      await handle.dispose().catch(() => undefined)
    }
    captureHandles = []
    await app.stop()
    console.info(`[AgentLens] daemon stopped (${signal}, mode=${daemonMode}, uptime=${runtimeAge()})`)
    process.exitCode = 0
  } catch (error) {
    console.error('[AgentLens] daemon shutdown failed', error)
    process.exitCode = 1
  }
}

function handleSignal(signal: 'SIGINT' | 'SIGTERM'): void {
  console.warn(
    `[AgentLens] daemon received ${signal} (mode=${daemonMode}, interactive=${interactiveTerminal}, pid=${process.pid}, ppid=${process.ppid}, uptime=${runtimeAge()})`,
  )

  if (signal === 'SIGINT' && (daemonMode === 'managed' || !interactiveTerminal)) {
    console.warn('[AgentLens] ignored SIGINT outside interactive foreground mode; use SIGTERM for intentional shutdown')
    return
  }

  void shutdown(signal)
}

process.on('SIGINT', () => handleSignal('SIGINT'))
process.on('SIGTERM', () => handleSignal('SIGTERM'))

try {
  await app.start()
  console.info(
    `[AgentLens] 1.0 runtime started (db: ${dbPath}, mode=${daemonMode}, interactive=${interactiveTerminal}, pid=${process.pid}, ppid=${process.ppid})`,
  )
  console.info(`[AgentLens] Web/UI: http://127.0.0.1:${configuredPort} (root: ${webRoot})`)
  console.info(`[AgentLens] backup vault: ${vaultPath}`)
  console.info(`[AgentLens] capture policy: prompt=${app.context.capturePolicy.modeFor('prompt')} tool=${app.context.capturePolicy.modeFor('tool')} config=${app.context.capturePolicy.modeFor('config')} environment=${app.context.capturePolicy.modeFor('environment')}`)
  console.info(`[AgentLens] enabled sources: ${app.context.capturePolicy.settings.enabledSources.join(', ') || '(none)'}`)

  const prepared = await prepareRegisteredSources(app.context, runtimeController.signal)
  logSourceFailures(prepared.failures)

  const capture = await startRegisteredSourceCapture(
    app.context,
    runtimeController.signal,
    prepared.targets,
  )
  captureHandles = capture.results
  logSourceFailures(capture.failures)
  for (const handle of captureHandles) {
    console.info(`[AgentLens] runtime capture started: ${handle.sourceId}`)
  }

  syncPromise = (async () => {
    await new Promise(resolve => setTimeout(resolve, INITIAL_BACKGROUND_SYNC_DELAY_MS))
    if (runtimeController.signal.aborted) return

    try {
      await app.context.projections.rebuild(SESSION_SUMMARY_PROJECTION_ID)
      console.info('[AgentLens] session summary projection rebuilt')
    } catch (error) {
      console.error('[AgentLens] session summary projection rebuild failed', error)
    }

    if (runtimeController.signal.aborted) return

    const [history, assets] = await Promise.all([
      syncRegisteredSourceHistory(app.context, runtimeController.signal, prepared.targets),
      discoverRegisteredSourceAssets(app.context, runtimeController.signal, prepared.targets),
    ])
    logSourceFailures([...history.failures, ...assets.failures])
    for (const result of history.results) {
      console.info(
        `[AgentLens] history synced: ${result.sourceId} records=${result.records} created=${result.observationsCreated} merged=${result.observationsMerged} unchanged=${result.observationsUnchanged}`,
      )
    }
    for (const result of assets.results) {
      console.info(
        `[AgentLens] assets scanned: ${result.sourceId} assets=${result.assetsDiscovered} states=${result.statesRecorded}`,
      )
    }
  })()
  await syncPromise
} catch (error) {
  runtimeController.abort()
  for (const handle of [...captureHandles].reverse()) {
    await handle.dispose().catch(() => undefined)
  }
  await app.stop().catch(() => undefined)
  console.error('[AgentLens] daemon startup failed', error)
  process.exitCode = 1
}
