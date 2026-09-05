import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MaintenanceJobStore } from '@agent-lens/core'
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
  replayRegisteredSourceHistory,
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
import {
  DEFAULT_AGENT_LENS_HTTP_PORT,
  httpSurfacePlugin,
} from '@agent-lens/surface-http'
import { webPlugin } from '@agent-lens/web'
import { dataRuntimeStoragePlugin } from './data-runtime/storage-plugin.js'
import {
  beginSessionSummaryProjectionRun,
  markSessionSummaryProjectionClean,
} from './projection-readiness.js'
import {
  createProgressiveHistoryStages,
  createParserReplayMaintenanceStages,
  parserReplayMaintenanceStagesAllowedByCapacity,
  stagesAllowedByCapacity,
  storageCapacityState,
  yieldToForeground,
} from './history-sync-plan.js'
import {
  attachHttpForegroundActivity,
  ForegroundActivityGate,
} from './maintenance-idle.js'
import {
  MAINTENANCE_PRIORITY,
  runMaintenanceJob,
} from './maintenance-jobs.js'
import {
  backfillToolUsageFactProjection,
  backfillUnknownObservationProjection,
  type ProjectionBackfillMaintenance,
} from './projection-backfill-maintenance.js'
import {
  compressLegacySourceRecords,
  ensureDeferredStorageIndexes,
  type DeferredIndexMaintenance,
  type SourceRecordCompressionMaintenance,
} from './storage-maintenance.js'
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
app.use(dataRuntimeStoragePlugin, { path: dbPath })
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
app.use(httpSurfacePlugin, {
  port: configuredPort,
  dataRuntimeHealth: () => app.context.dataRuntime.snapshot(),
})
app.use(webPlugin, { staticDir: webRoot })

const runtimeController = new AbortController()
let syncPromise: Promise<void> | null = null
let captureHandles: Awaited<ReturnType<typeof startRegisteredSourceCapture>>['results'] = []
let shuttingDown = false
let reuseSessionSummaryProjection = false
let sessionSummaryProjectionReady = false
let foregroundGate: ForegroundActivityGate | null = null
let disposeHttpActivityTracking: (() => void) | null = null

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
    disposeHttpActivityTracking?.()
    disposeHttpActivityTracking = null
    foregroundGate = null
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
  foregroundGate = new ForegroundActivityGate()
  disposeHttpActivityTracking = attachHttpForegroundActivity(app.context.http.server, foregroundGate)
  const storageExtensions = app.context.storage as typeof app.context.storage & {
    maintenanceJobs?: MaintenanceJobStore
    maintenance?: DeferredIndexMaintenance & SourceRecordCompressionMaintenance
    projectionBackfill?: ProjectionBackfillMaintenance
  }
  const maintenanceJobs = storageExtensions.maintenanceJobs
  const storageMaintenance = storageExtensions.maintenance
  const projectionBackfill = storageExtensions.projectionBackfill

  console.info(
    `[AgentLens] 1.0 runtime started (db: ${dbPath}, mode=${daemonMode}, interactive=${interactiveTerminal}, pid=${process.pid}, ppid=${process.ppid})`,
  )
  console.info(`[AgentLens] Data Runtime: writer=${app.context.dataRuntime.writer.state()} reader=${app.context.dataRuntime.reader.state()}`)
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

  syncPromise = (async () => {
    await new Promise(resolve => setTimeout(resolve, INITIAL_BACKGROUND_SYNC_DELAY_MS))
    if (runtimeController.signal.aborted) return

    const prepared = await prepareRegisteredSources(app.context, runtimeController.signal)
    logSourceFailures(prepared.failures)
    if (runtimeController.signal.aborted) return

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
    if (runtimeController.signal.aborted) return

    if (reuseSessionSummaryProjection) {
      console.info('[AgentLens] session summary projection reused from clean shutdown')
    } else {
      try {
        console.info('[AgentLens] session summary projection cooperative rebuild started')
        const projectionRun = await runMaintenanceJob(
          maintenanceJobs,
          {
            id: 'projection:session-summary',
            type: 'projection-rebuild',
            scope: SESSION_SUMMARY_PROJECTION_ID,
            priority: MAINTENANCE_PRIORITY.projection,
          },
          runtimeController.signal,
          async () => {
            await app.context.projections.rebuild(SESSION_SUMMARY_PROJECTION_ID, {
              signal: runtimeController.signal,
            })
            return { rebuilt: true }
          },
          value => value,
        )
        if (projectionRun?.status === 'contended' || projectionRun?.status === 'paused') {
          sessionSummaryProjectionReady = false
          console.warn(`[AgentLens] session summary projection maintenance ${projectionRun.status}`)
        } else {
          sessionSummaryProjectionReady = true
          console.info('[AgentLens] session summary projection rebuilt')
        }
      } catch (error) {
        if (runtimeController.signal.aborted) return
        sessionSummaryProjectionReady = false
        console.error('[AgentLens] session summary projection rebuild failed', error)
      }
    }

    if (runtimeController.signal.aborted) return

    const storageHealth = await app.context.storage.health()
    const capacityState = storageCapacityState(storageHealth.details)
    const plannedHistoryStages = createProgressiveHistoryStages(startedAt)
    const historyStages = stagesAllowedByCapacity(plannedHistoryStages, capacityState)
    if (historyStages.length < plannedHistoryStages.length) {
      const allowed = new Set(historyStages.map(stage => stage.id))
      const paused = plannedHistoryStages.filter(stage => !allowed.has(stage.id)).map(stage => stage.label)
      console.warn(`[AgentLens] history stages paused: ${paused.join(', ')}; storage capacity=${capacityState}`)
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

    // Parser Replay 完全退出启动链路；只允许在下面的空闲 Maintenance Job 中执行。
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
    if (runtimeController.signal.aborted) return

    const gate = foregroundGate
    if (!gate) return
    await gate.wait(runtimeController.signal)
    if (runtimeController.signal.aborted) return

    const preMaintenanceHealth = await app.context.storage.health()
    const preMaintenanceCapacity = storageCapacityState(preMaintenanceHealth.details)

    if (preMaintenanceCapacity === 'exceeded') {
      console.warn('[AgentLens] storage capacity exceeded; projection backfill, deferred indexes and parser replay are paused')
    } else {
      const backfills = [
        {
          id: 'projection:unknown-observation:v17',
          scope: 'unknown-observation-v17',
          label: 'Unknown Observation',
          run: backfillUnknownObservationProjection,
        },
        {
          id: 'projection:tool-usage-facts:v18',
          scope: 'tool-usage-facts-v18',
          label: 'Tool Usage Facts',
          run: backfillToolUsageFactProjection,
        },
      ] as const

      for (const backfill of backfills) {
        if (runtimeController.signal.aborted) return
        try {
          const run = await runMaintenanceJob(
            maintenanceJobs,
            {
              id: backfill.id,
              type: 'projection-rebuild',
              scope: backfill.scope,
              priority: MAINTENANCE_PRIORITY.projection,
            },
            runtimeController.signal,
            async job => backfill.run(
              projectionBackfill,
              gate,
              runtimeController.signal,
              {
                initialProgress: job.initialProgress,
                batchSize: 250,
                report: job.report,
              },
            ),
            value => ({
              scanned: value.scanned,
              written: value.written,
              batches: value.batches,
              ...(value.cursor ? { cursor: value.cursor } : {}),
              aborted: value.aborted,
            }),
          )
          if (run?.status === 'contended') {
            console.warn(`[AgentLens] ${backfill.label} projection backfill contended`)
          } else if (run?.value) {
            console.info(`[AgentLens] ${backfill.label} projection backfill: scanned=${run.value.scanned} written=${run.value.written} batches=${run.value.batches}`)
          }
        } catch (error) {
          if (!runtimeController.signal.aborted) {
            console.error(`[AgentLens] ${backfill.label} projection backfill failed`, error)
          }
        }
      }

      try {
        const indexRun = await runMaintenanceJob(
          maintenanceJobs,
          {
            id: 'storage:deferred-indexes',
            type: 'deferred-indexes',
            scope: 'sqlite-primary',
            priority: MAINTENANCE_PRIORITY.deferredIndexes,
          },
          runtimeController.signal,
          async () => {
            const indexes = await ensureDeferredStorageIndexes(
              storageMaintenance,
              gate,
              runtimeController.signal,
            )
            return indexes ?? { created: [], existing: [] }
          },
          value => ({ created: value.created, existing: value.existing }),
        )
        if (indexRun?.status === 'contended' || indexRun?.status === 'paused') {
          console.warn(`[AgentLens] deferred storage index maintenance ${indexRun.status}; parser replay skipped`)
        } else if (indexRun?.value?.created.length) {
          console.info(`[AgentLens] deferred storage indexes created: ${indexRun.value.created.join(', ')}`)
        }
      } catch (error) {
        if (!runtimeController.signal.aborted) {
          console.error('[AgentLens] deferred storage index maintenance failed; parser replay skipped', error)
        }
      }
    }

    if (runtimeController.signal.aborted) return

    const maintenanceHealth = await app.context.storage.health()
    const maintenanceCapacityState = storageCapacityState(maintenanceHealth.details)
    const plannedMaintenanceStages = createParserReplayMaintenanceStages(startedAt)
    const maintenanceStages = parserReplayMaintenanceStagesAllowedByCapacity(
      plannedMaintenanceStages,
      maintenanceCapacityState,
    )
    if (maintenanceStages.length < plannedMaintenanceStages.length) {
      const allowed = new Set(maintenanceStages.map(stage => stage.id))
      const paused = plannedMaintenanceStages.filter(stage => !allowed.has(stage.id)).map(stage => stage.label)
      console.warn(`[AgentLens] parser replay maintenance paused: ${paused.join(', ')}; storage capacity=${maintenanceCapacityState}`)
    }

    for (const stage of maintenanceStages) {
      if (runtimeController.signal.aborted) return
      console.info(`[AgentLens] parser replay maintenance stage started: ${stage.label}`)
      const replayRun = await runMaintenanceJob(
        maintenanceJobs,
        {
          id: `parser-replay:${stage.id}`,
          type: 'parser-replay',
          scope: stage.id,
          priority: MAINTENANCE_PRIORITY.replay,
          progress: { stage: stage.id },
        },
        runtimeController.signal,
        async job => {
          await gate.wait(runtimeController.signal)
          if (runtimeController.signal.aborted) {
            return { stage: stage.id, sources: 0, failures: 0, records: 0 }
          }
          const replay = await replayRegisteredSourceHistory(
            app.context,
            runtimeController.signal,
            prepared.targets,
            stage.window,
            { cooperate: () => gate.wait(runtimeController.signal) },
          )
          logSourceFailures(replay.failures)
          for (const result of replay.results) {
            console.info(
              `[AgentLens] parser replay maintenance: stage=${stage.id} source=${result.sourceId} records=${result.records} created=${result.observationsCreated} merged=${result.observationsMerged} unchanged=${result.observationsUnchanged}`,
            )
          }
          const progress = {
            stage: stage.id,
            sources: replay.results.length,
            failures: replay.failures.length,
            records: replay.results.reduce((sum, item) => sum + item.records, 0),
          }
          await job.report(progress)
          await yieldToForeground(runtimeController.signal)
          return progress
        },
        value => value,
      )
      if (replayRun?.status === 'contended') {
        console.warn(`[AgentLens] parser replay maintenance contended: stage=${stage.id}`)
      }
    }

    if (runtimeController.signal.aborted) return
    try {
      const compressionRun = await runMaintenanceJob(
        maintenanceJobs,
        {
          id: 'source-record:compression',
          type: 'source-record-compression',
          scope: 'legacy-json',
          priority: MAINTENANCE_PRIORITY.compression,
        },
        runtimeController.signal,
        async job => {
          const compression = await compressLegacySourceRecords(
            storageMaintenance,
            gate,
            runtimeController.signal,
            {
              batchSize: 50,
              onBatch(batch) {
                if (!batch.scanned) return
                console.info(
                  `[AgentLens] SourceRecord compression: scanned=${batch.scanned} compressed=${batch.compressed} plain=${batch.plain} saved=${batch.savedBytes}`,
                )
              },
            },
          )
          await job.report({
            scanned: compression.scanned,
            compressed: compression.compressed,
            plain: compression.plain,
            savedBytes: compression.savedBytes,
            batches: compression.batches,
          })
          return compression
        },
        value => ({
          scanned: value.scanned,
          compressed: value.compressed,
          plain: value.plain,
          savedBytes: value.savedBytes,
          batches: value.batches,
          aborted: value.aborted,
        }),
      )
      const compression = compressionRun?.value
      if (compression && compression.scanned > 0) {
        console.info(
          `[AgentLens] SourceRecord compression completed: scanned=${compression.scanned} compressed=${compression.compressed} plain=${compression.plain} saved=${compression.savedBytes} batches=${compression.batches}`,
        )
      }
    } catch (error) {
      if (!runtimeController.signal.aborted) {
        console.error('[AgentLens] SourceRecord compression maintenance failed', error)
      }
    }
  })()
  await syncPromise
} catch (error) {
  runtimeController.abort()
  disposeHttpActivityTracking?.()
  disposeHttpActivityTracking = null
  foregroundGate = null
  for (const handle of [...captureHandles].reverse()) {
    await handle.dispose().catch(() => undefined)
  }
  await app.stop().catch(() => undefined)
  console.error('[AgentLens] daemon startup failed', error)
  process.exitCode = 1
}
