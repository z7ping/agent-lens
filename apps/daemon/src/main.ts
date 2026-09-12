import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupLocalPlugin } from '@agent-lens/backup-local'
import { capturePolicyPlugin, resolveCapturePolicyPluginState } from '@agent-lens/capture-policy'
import {
  readCapturePolicyConfigurationSync,
  writeCapturePolicyConfiguration,
} from '@agent-lens/capture-policy/configuration'
import { IntegrationPackageService } from '@agent-lens/integration-packages'
import {
  SESSION_SUMMARY_PROJECTION_ID,
  sessionSummaryProjectionPlugin,
} from '@agent-lens/projection-session'
import {
  abortableDelay,
  AgentLensApplication,
  coreServicesPlugin,
  authorizedIntegrationCapabilities,
  discoverRegisteredSourceAssets,
  grantIntegrationCapabilities,
  integrationAuthorizationPath,
  integrationPreferencesPath,
  IntegrationManagementService,
  IntegrationPreferenceService,
  loadInstalledAgentIntegration,
  nodeRuntimePlugin,
  OfficialToolDiscoveryService,
  prepareRegisteredSources,
  readIntegrationAuthorizationSync,
  replayRegisteredSourceHistory,
  resolveAgentLensNodeRuntime,
  startRegisteredSourceCapture,
  syncRegisteredSourceHistory,
  writeIntegrationAuthorization,
  type RegisteredSourceFailure,
} from '@agent-lens/runtime-cordis'
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
} from './projection-backfill-maintenance.js'
import {
  compressLegacySourceRecords,
  ensureDeferredStorageIndexes,
} from './storage-maintenance.js'
import { profiledDshSourcePlugin } from './sources/dsh-profiled.js'
import { createProjectDirectoryPicker } from './project-directory-picker.js'

const nodeRuntime = resolveAgentLensNodeRuntime()
const { dataRoot, profile: runtimeProfile, capabilities } = nodeRuntime
const officialToolDiscovery = capabilities.localCapture
  ? new OfficialToolDiscoveryService()
  : null
const dbPath = process.env.AGENT_LENS_DB_PATH
  ?? join(dataRoot, 'agent-lens.db')
const vaultPath = process.env.AGENT_LENS_VAULT_PATH
  ?? join(dataRoot, 'vault')
const localePackDirectory = process.env.AGENT_LENS_LOCALE_PACK_DIR
  ?? join(dataRoot, 'locales')
const bundledIntegrationPackageDir = fileURLToPath(new URL('./integration-packages/', import.meta.url))
const workspaceIntegrationPackageDir = fileURLToPath(new URL('../../../dist/integration-packages/', import.meta.url))
const integrationBundleDir = process.env.AGENT_LENS_INTEGRATION_BUNDLE_DIR
  ?? (existsSync(join(bundledIntegrationPackageDir, 'catalog.json'))
    ? bundledIntegrationPackageDir
    : workspaceIntegrationPackageDir)
const integrationInstallRoot = process.env.AGENT_LENS_INTEGRATIONS_DIR
  ?? join(dataRoot, 'integrations')
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
const INITIAL_BACKGROUND_SYNC_DELAY_MS = 2_000
const DATA_RUNTIME_RECOVERY_POLL_MS = 500
let foregroundGate: ForegroundActivityGate | null = null
const projectDirectoryPicker = createProjectDirectoryPicker()
let capturePolicyStartup = resolveCapturePolicyPluginState()
let persistedCapturePolicy = readCapturePolicyConfigurationSync(capturePolicyStartup.configurationPath)
const legacyInstallation = existsSync(dbPath) || persistedCapturePolicy !== null
const explicitSourceOverride = process.env.AGENT_LENS_ENABLED_SOURCES !== undefined

// Physical Integration installs are opt-in for a genuinely fresh local
// installation. Preserve every legacy/user/environment configuration.
if (
  capabilities.localCapture
  && !legacyInstallation
  && !explicitSourceOverride
  && persistedCapturePolicy === null
) {
  await writeCapturePolicyConfiguration(capturePolicyStartup.configurationPath, [])
  capturePolicyStartup = resolveCapturePolicyPluginState()
  persistedCapturePolicy = readCapturePolicyConfigurationSync(capturePolicyStartup.configurationPath)
}

const enabledSourceIds = new Set(capturePolicyStartup.settings.enabledSources)
const integrationAuthorizationFile = integrationAuthorizationPath()
const integrationPreferencesFile = integrationPreferencesPath()
const integrationPreferences = capabilities.localCapture
  ? new IntegrationPreferenceService(integrationPreferencesFile)
  : null
let integrationAuthorization = readIntegrationAuthorizationSync(integrationAuthorizationFile)

if (!integrationAuthorization && legacyInstallation) {
  integrationAuthorization = await writeIntegrationAuthorization(integrationAuthorizationFile, {
    grants: {
      ...(enabledSourceIds.has('pi') ? { pi: ['runtime', 'live'] } : {}),
      ...(enabledSourceIds.has('hermes') ? { hermes: ['live'] } : {}),
    },
  })
}

function authorizedCapabilities(productId: string) {
  return authorizedIntegrationCapabilities(integrationAuthorization, productId)
}

const app = new AgentLensApplication()
const integrationPackageLoadFailures: Array<{ integrationId: string; error: string }> = []
let integrationPackages: IntegrationPackageService | null = null
if (capabilities.localCapture && existsSync(join(integrationBundleDir, 'catalog.json'))) {
  const candidate = new IntegrationPackageService({
    bundleDir: integrationBundleDir,
    installRoot: integrationInstallRoot,
    canRemove: integrationId => app.integrationStatus(integrationId)
      ? {
          allowed: false,
          reason: 'Integration is loaded in the current AgentLens runtime; disable/restart before removal',
        }
      : { allowed: true },
  })
  try {
    await candidate.initialize()
    const legacySelected = legacyInstallation || explicitSourceOverride
      ? candidate.catalog()
          .filter(item => enabledSourceIds.has(item.productId))
          .map(item => item.integrationId)
      : []
    await candidate.ensureLegacyPhysicalization(legacySelected)
    integrationPackages = candidate
  } catch (error) {
    console.warn('[AgentLens] Integration package lifecycle unavailable', error)
  }
}

let integrationManagement: IntegrationManagementService | null = null

function currentIntegrationManagement(): IntegrationManagementService {
  if (!officialToolDiscovery || !integrationPreferences) {
    throw new Error('Integration management is unavailable for this runtime profile')
  }
  integrationManagement ??= new IntegrationManagementService({
    discovery: officialToolDiscovery,
    preferences: integrationPreferences,
    capturePolicy: app.context.capturePolicy,
    integrationStatus: productId => app.resolveIntegrationStatus(productId),
  })
  return integrationManagement
}

app.useRuntime(nodeRuntimePlugin, nodeRuntime)
app.use(dataRuntimeStoragePlugin, { path: dbPath })
app.useRuntime(coreServicesPlugin)
app.useRuntime(sessionSummaryProjectionPlugin)
app.useRuntime(capturePolicyPlugin)
if (capabilities.localCapture) {
  if (integrationPackages) {
    for (const item of integrationPackages.catalog()) {
      if (!enabledSourceIds.has(item.productId)) continue
      const state = integrationPackages.state(item.integrationId)
      if (
        !state.installed
        || state.integrity !== 'verified'
        || state.compatibility !== 'compatible'
      ) {
        if (state.installed) {
          integrationPackageLoadFailures.push({
            integrationId: item.integrationId,
            error: state.reason
              ?? `Integration package cannot load: integrity=${state.integrity} compatibility=${state.compatibility}`,
          })
        }
        continue
      }
      const entryPath = integrationPackages.installedEntryPath(item.integrationId)
      if (!entryPath) continue
      try {
        const integration = await loadInstalledAgentIntegration(entryPath, item.integrationId)
        app.useIntegration(integration, {
          enabled: true,
          authorizedCapabilities: authorizedCapabilities(integration.manifest.productId),
        })
      } catch (error) {
        integrationPackageLoadFailures.push({
          integrationId: item.integrationId,
          error: error instanceof Error ? error.message : String(error),
        })
        console.error(`[AgentLens] installed Integration load failed: ${item.integrationId}`, error)
      }
    }
  }
  app.use(profiledDshSourcePlugin)
}
app.useRuntime(backupLocalPlugin, { vaultPath })
app.use(httpSurfacePlugin, {
  port: configuredPort,
  localePackDirectory,
  selectProjectDirectory: () => projectDirectoryPicker.select(),
  dataRuntimeHealth: () => app.context.dataRuntime.snapshot(),
  healthDetails: () => ({
    ...(foregroundGate ? { maintenanceGate: foregroundGate.snapshot() } : {}),
    ...(officialToolDiscovery
      ? {
          toolDiscovery: (() => {
            const snapshot = officialToolDiscovery.snapshot()
            return {
              status: snapshot.status,
              ...(snapshot.completedAt ? { completedAt: snapshot.completedAt } : {}),
            }
          })(),
        }
      : {}),
    integrationPackageLoadFailures,
    integrationFailures: app.integrationFailures.map(failure => ({
      integrationId: failure.integrationId,
      componentPluginId: failure.componentPluginId,
      error: failure.error instanceof Error ? failure.error.message : String(failure.error),
    })),
  }),
  integrationStatus: productId => app.resolveIntegrationStatus(productId),
  ...(officialToolDiscovery
    ? {
        integrationDiscovery: {
          snapshot: () => officialToolDiscovery.snapshot(),
          rescan: () => officialToolDiscovery.rescan(),
        },
      }
    : {}),
  ...(officialToolDiscovery && integrationPreferences
    ? {
        integrationManagement: {
          query: () => currentIntegrationManagement().query(),
          preferences: () => currentIntegrationManagement().preferences(),
          updatePreferences: request => currentIntegrationManagement().updatePreferences(request),
          enabled: integrationId => currentIntegrationManagement().enabled(integrationId),
          setEnabled: (integrationId, enabled) =>
            currentIntegrationManagement().setEnabled(integrationId, enabled),
        },
      }
    : {}),
  ...(integrationPackages
    ? {
        integrationPackages: {
          catalog: () => integrationPackages!.catalog(),
          states: () => integrationPackages!.statesSnapshot(),
          state: integrationId => {
            try {
              return integrationPackages!.state(integrationId)
            } catch {
              return null
            }
          },
          install: integrationId => integrationPackages!.install(integrationId),
          remove: integrationId => integrationPackages!.remove(integrationId),
          update: integrationId => integrationPackages!.update(integrationId),
          operation: operationId => integrationPackages!.operation(operationId),
        },
      }
    : {}),
  integrationAuthorization: {
    available: productId => app.authorizableCapabilities(productId)
      .filter((capability): capability is 'hook' | 'runtime' | 'live' => capability !== 'source'),
    grant: async (productId, capabilities) => {
      integrationAuthorization = await grantIntegrationCapabilities(
        integrationAuthorizationFile,
        productId,
        capabilities,
      )
      app.recordIntegrationAuthorization(productId, capabilities)
      return authorizedIntegrationCapabilities(integrationAuthorization, productId)
    },
  },
})
app.use(webPlugin, { staticDir: webRoot })

const runtimeController = new AbortController()
let syncPromise: Promise<void> | null = null
let captureHandles: Awaited<ReturnType<typeof startRegisteredSourceCapture>>['results'] = []
let shuttingDown = false
let reuseSessionSummaryProjection = false
let sessionSummaryProjectionReady = false
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

async function disposeCaptureHandles(): Promise<void> {
  const handles = [...captureHandles].reverse()
  captureHandles = []
  for (const handle of handles) {
    try {
      await handle.dispose()
    } catch {
      // Best-effort cleanup must not hide the primary shutdown/startup error.
    }
  }
}

async function waitForDataRuntime(signal: AbortSignal): Promise<boolean> {
  let announced = false
  while (!signal.aborted) {
    if (app.context.dataRuntime.snapshot().ok) return true
    if (!announced) {
      announced = true
      console.warn('[AgentLens] background data work paused while Data Runtime recovers')
    }
    await abortableDelay(DATA_RUNTIME_RECOVERY_POLL_MS, signal)
  }
  return false
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  runtimeController.abort()

  try {
    if (syncPromise) await syncPromise.catch(() => undefined)
    await disposeCaptureHandles()
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
  if (officialToolDiscovery) {
    void officialToolDiscovery.rescan()
      .then(snapshot => {
        const present = snapshot.items.filter(item => item.presence === 'present').length
        const dataOnly = snapshot.items.filter(item => item.presence === 'data-only').length
        console.info(`[AgentLens] tool discovery completed: present=${present} dataOnly=${dataOnly}`)
      })
      .catch(error => {
        console.warn('[AgentLens] tool discovery failed', error)
      })
  }
  foregroundGate = new ForegroundActivityGate({
    loadProbe: () => ({
      foregroundPending: app.context.dataRuntime.foregroundPending(),
      writerPending: app.context.dataRuntime.writerPending(),
    }),
  })
  disposeHttpActivityTracking = attachHttpForegroundActivity(app.context.http.server, foregroundGate)
  const maintenanceJobs = app.context.storage.maintenanceJobs
  const storageMaintenance = app.context.storage.maintenance
  const projectionBackfill = app.context.storage.projectionBackfill

  console.info(
    `[AgentLens] 1.0 runtime started (db: ${dbPath}, mode=${daemonMode}, interactive=${interactiveTerminal}, pid=${process.pid}, ppid=${process.ppid})`,
  )
  const dataRuntimeSnapshot = app.context.dataRuntime.snapshot()
  console.info(`[AgentLens] Data Runtime: writer=${dataRuntimeSnapshot.writer.state} readers=${dataRuntimeSnapshot.readers.map(reader => reader.state).join(',')} maintenance=${dataRuntimeSnapshot.maintenanceReader.state}`)
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
    await abortableDelay(INITIAL_BACKGROUND_SYNC_DELAY_MS, runtimeController.signal)
    if (!await waitForDataRuntime(runtimeController.signal)) return

    const initialStorageHealth = await app.context.storage.health()
    const initialCapacityState = storageCapacityState(initialStorageHealth.details)

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
    } else if (initialCapacityState === 'exceeded' || initialCapacityState === 'unknown') {
      sessionSummaryProjectionReady = false
      console.warn(`[AgentLens] session summary projection rebuild paused; storage capacity=${initialCapacityState}`)
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
            const gate = foregroundGate
            if (gate) await gate.wait(runtimeController.signal)
            if (runtimeController.signal.aborted) return { rebuilt: false }
            await app.context.projections.rebuild(SESSION_SUMMARY_PROJECTION_ID, {
              signal: runtimeController.signal,
            })
            return { rebuilt: true }
          },
          value => value,
        )
        if (projectionRun?.status === 'contended' || projectionRun?.status === 'paused' || !projectionRun?.value?.rebuilt) {
          sessionSummaryProjectionReady = false
          console.warn(`[AgentLens] session summary projection maintenance ${projectionRun?.status ?? 'paused'}`)
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

    if (capacityState !== 'exceeded' && capacityState !== 'unknown') {
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
    } else {
      console.warn(`[AgentLens] asset discovery paused; storage capacity=${capacityState}`)
    }
    if (runtimeController.signal.aborted) return

    const gate = foregroundGate
    if (!gate) return
    await gate.wait(runtimeController.signal)
    if (runtimeController.signal.aborted) return

    const preMaintenanceHealth = await app.context.storage.health()
    const preMaintenanceCapacity = storageCapacityState(preMaintenanceHealth.details)
    const capacityConstrained = preMaintenanceCapacity === 'exceeded' || preMaintenanceCapacity === 'unknown'

    // Tool Usage Facts are a correctness projection, not optional expansion. If
    // this backfill is permanently skipped on a large store the Tools/Agents UI
    // silently becomes incomplete forever. Keep it resumable and foreground-gated,
    // but shrink the batch while capacity is constrained.
    try {
      const toolFactRun = await runMaintenanceJob(
        maintenanceJobs,
        {
          id: 'projection:tool-usage-facts:v18',
          type: 'projection-rebuild',
          scope: 'tool-usage-facts-v18',
          priority: MAINTENANCE_PRIORITY.projection,
        },
        runtimeController.signal,
        async job => backfillToolUsageFactProjection(
          projectionBackfill,
          gate,
          runtimeController.signal,
          {
            ...(job.initialProgress === undefined ? {} : { initialProgress: job.initialProgress }),
            batchSize: capacityConstrained ? 50 : 250,
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
      if (toolFactRun?.status === 'contended') {
        console.warn('[AgentLens] Tool Usage Facts projection backfill contended')
      } else if (toolFactRun?.value) {
        console.info(`[AgentLens] Tool Usage Facts projection backfill: scanned=${toolFactRun.value.scanned} written=${toolFactRun.value.written} batches=${toolFactRun.value.batches} constrained=${capacityConstrained}`)
      }
    } catch (error) {
      if (!runtimeController.signal.aborted) {
        console.error('[AgentLens] Tool Usage Facts projection backfill failed', error)
      }
    }

    if (runtimeController.signal.aborted) return

    if (capacityConstrained) {
      console.warn(`[AgentLens] storage capacity=${preMaintenanceCapacity}; non-essential projection backfill, deferred indexes and parser replay remain paused; Tool Usage Facts consistency backfill is still enabled`)
    } else {
      try {
        const unknownRun = await runMaintenanceJob(
          maintenanceJobs,
          {
            id: 'projection:unknown-observation:v17',
            type: 'projection-rebuild',
            scope: 'unknown-observation-v17',
            priority: MAINTENANCE_PRIORITY.projection,
          },
          runtimeController.signal,
          async job => backfillUnknownObservationProjection(
            projectionBackfill,
            gate,
            runtimeController.signal,
            {
              ...(job.initialProgress === undefined ? {} : { initialProgress: job.initialProgress }),
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
        if (unknownRun?.status === 'contended') {
          console.warn('[AgentLens] Unknown Observation projection backfill contended')
        } else if (unknownRun?.value) {
          console.info(`[AgentLens] Unknown Observation projection backfill: scanned=${unknownRun.value.scanned} written=${unknownRun.value.written} batches=${unknownRun.value.batches}`)
        }
      } catch (error) {
        if (!runtimeController.signal.aborted) {
          console.error('[AgentLens] Unknown Observation projection backfill failed', error)
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
        async job => compressLegacySourceRecords(
          storageMaintenance,
          gate,
          runtimeController.signal,
          {
            ...(job.initialProgress === undefined ? {} : { initialProgress: job.initialProgress }),
            batchSize: 50,
            report: job.report,
            onBatch(batch) {
              if (!batch.scanned) return
              console.info(
                `[AgentLens] SourceRecord compression: scanned=${batch.scanned} compressed=${batch.compressed} plain=${batch.plain} saved=${batch.savedBytes}`,
              )
            },
          },
        ),
        value => ({
          scanned: value.scanned,
          compressed: value.compressed,
          plain: value.plain,
          savedBytes: value.savedBytes,
          batches: value.batches,
          ...(value.cursor ? { cursor: value.cursor } : {}),
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

  await syncPromise.catch(error => {
    if (!runtimeController.signal.aborted) {
      console.error('[AgentLens] background data work failed; control plane remains online', error)
    }
  })
} catch (error) {
  runtimeController.abort()
  disposeHttpActivityTracking?.()
  disposeHttpActivityTracking = null
  foregroundGate = null
  await disposeCaptureHandles()
  await app.stop().catch(() => undefined)
  console.error('[AgentLens] daemon startup failed', error)
  process.exitCode = 1
}
