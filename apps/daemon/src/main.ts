import { existsSync } from 'node:fs'
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
  nodeRuntimePlugin,
  piLiveRuntimePlugin,
  prepareRegisteredSources,
  resolveAgentLensNodeRuntime,
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
import {
  beginSessionSummaryProjectionRun,
  markSessionSummaryProjectionClean,
} from './projection-readiness.js'
import {
  createProgressiveHistoryStages,
  stagesAllowedByCapacity,
  storageCapacityState,
  yieldToForeground,
} from './history-sync-plan.js'
import { profiledDshSourcePlugin } from './sources/dsh-profiled.js'

const nodeRuntime = resolveAgentLensNodeRuntime()
const { dataRoot, profile: runtimeProfile, capabilities } = nodeRuntime
const dbPath = process.env.AGENT_LENS_DB_PATH
  ?? join(dataRoot, 'agent-lens.db')
const vaultPath = process.env.AGENT_LENS_VAULT_PATH
  ?? join(dataRoot, 'vault')
const configuredPort = process.env.AGENT_LENS_PORT
  ? Number(process.env.AGENT_LENS_PORT)
  : DEFAULT_AGENT_LENS_HTTP_PORT
const bundledWebRoot = fileURLToPath(new URL('./web/', import.meta.url))
const workspaceWebRoot = fileURLToPath(new URL('../../../packages/web/dist/', import.meta.url))
const webRoot = process.env.AGENT_LENS_WEB_ROOT
  ?? (existsSync(fileURLToPath(new URL('./web/index.html', import.meta.url))) ? bundledWebRoot : workspaceWebRoot)
const daemonMode = process.env.AGENT_LENS_DAEMON_MODE === 'managed' ? 'managed' : 'foreground'
const developmentApiPort = process.env.AGENT_LENS_DEV_API_PORT
const interactiveTerminal = Boolean(process.stdin.isTTY && process.stdout.isTTY)
const startedAt = Date.now()
// 为 Web Shell 的首轮 Health / Facet / Review 查询保留短暂宽限期；
// 历史和资产同步随后继续增量执行。
const INITIAL_BACKGROUND_SYNC_DELAY_MS = 2_000

const app = new AgentLensApplication()
app.useRuntime(nodeRuntimePlugin, nodeRuntime)
app.use(sqliteStoragePlugin, { path: dbPath })
app.useRuntime(coreServicesPlugin)
app.useRuntime(sessionSummaryProjectionPlugin)
app.useRuntime(capturePolicyPlugin)
app.useRuntime(piLiveRuntimePlugin)
if (capabilities.localCapture) {
  app.use(codexSourcePlugin)
  app.use(claudeSourcePlugin)
  app.use(piSourcePlugin)
  app.use(hermesSourcePlugin)
  app.use(openCodeSourcePlugin)
  app.use(profiledDshSourcePlugin)
}
app.useRuntime(backupLocalPlugin, { vaultPath })
app.use(httpSurfacePlugin, { port: configuredPort })
app.use(webPlugin, { staticDir: webRoot })

const runtimeController = new AbortController()
let syncPromise: Promise<void> | null = null
let captureHandles: Awaited<ReturnType<typeof startRegisteredSourceCapture>>['results'] = []
let shuttingDown = false
let reuseSessionSummaryProjection = false
let sessionSummaryProjectionReady = false

function runtimeAge(): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  return `${seconds}s`
}

function capabilitySummary(): string {
  return `localCapture=${capabilities.localCapture} replicationUpstream=${capabilities.replicationUpstream} hubAccept=${capabilities.hubAccept}`
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
    let readinessError: unknown
    if (sessionSummaryProjectionReady) {
      try {
        await markSessionSummaryProjectionClean(app.context.storage, app.context.projections)
      } catch (error) {
        readinessError = error
        console.error('[AgentLens] session summary projection clean checkpoint failed', error)
      }
    }
    await app.stop()
    if (readinessError) throw readinessError
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
  console.info(`[AgentLens] node: ${app.context.node.identity.nodeId} profile=${runtimeProfile} ${capabilitySummary()}`)
  if (developmentApiPort) {
    console.info(`[AgentLens] Runtime API: http://127.0.0.1:${configuredPort}`)
    console.info(`[AgentLens] static Web fallback root: ${webRoot}（源码开发请使用 Vite 地址）`)
  } else {
    console.info(`[AgentLens] Web/UI: http://127.0.0.1:${configuredPort} (root: ${webRoot})`)
  }
  console.info(`[AgentLens] backup vault: ${vaultPath}`)
  console.info(`[AgentLens] capture policy: prompt=${app.context.capturePolicy.modeFor('prompt')} tool=${app.context.capturePolicy.modeFor('tool')} config=${app.context.capturePolicy.modeFor('config')} environment=${app.context.capturePolicy.modeFor('environment')}`)
  console.info(`[AgentLens] enabled sources: ${app.context.capturePolicy.settings.enabledSources.join(', ') || '(none)'}`)
  if (!capabilities.localCapture) {
    console.info('[AgentLens] local source capture disabled by runtime profile')
  }

  reuseSessionSummaryProjection = await beginSessionSummaryProjectionRun(app.context.storage)
  sessionSummaryProjectionReady = reuseSessionSummaryProjection

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

    if (reuseSessionSummaryProjection) {
      console.info('[AgentLens] session summary projection reused from clean shutdown')
    } else {
      try {
        console.info('[AgentLens] session summary projection cooperative rebuild started')
        await app.context.projections.rebuild(SESSION_SUMMARY_PROJECTION_ID, {
          signal: runtimeController.signal,
        })
        sessionSummaryProjectionReady = true
        console.info('[AgentLens] session summary projection rebuilt')
      } catch (error) {
        if (runtimeController.signal.aborted) return
        sessionSummaryProjectionReady = false
        console.error('[AgentLens] session summary projection rebuild failed', error)
      }
    }

    if (runtimeController.signal.aborted) return

    // 历史任务是首要界面数据。先完成历史同步，再扫描静态资产，避免两个
    // 冷扫描器同时争用同一个 SQLite 执行器和磁盘。
    const storageHealth = await app.context.storage.health()
    const capacityState = storageCapacityState(storageHealth.details)
    const plannedHistoryStages = createProgressiveHistoryStages(startedAt)
    const historyStages = stagesAllowedByCapacity(plannedHistoryStages, capacityState)
    if (historyStages.length < plannedHistoryStages.length) {
      console.warn(`[AgentLens] 7-day history backfill paused: storage capacity=${capacityState}`)
    }
    for (const stage of historyStages) {
      if (runtimeController.signal.aborted) return
      console.info(`[AgentLens] history sync stage started: ${stage.label}`)
      const history = await syncRegisteredSourceHistory(
        app.context,
        runtimeController.signal,
        prepared.targets,
        stage.window,
      )
      logSourceFailures(history.failures)
      for (const result of history.results) {
        console.info(
          `[AgentLens] history synced: stage=${stage.id} source=${result.sourceId} records=${result.records} created=${result.observationsCreated} merged=${result.observationsMerged} unchanged=${result.observationsUnchanged}`,
        )
      }
      await yieldToForeground(runtimeController.signal)
    }
    if (runtimeController.signal.aborted) return

    const assets = await discoverRegisteredSourceAssets(
      app.context,
      runtimeController.signal,
      prepared.targets,
    )
    logSourceFailures(assets.failures)
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
