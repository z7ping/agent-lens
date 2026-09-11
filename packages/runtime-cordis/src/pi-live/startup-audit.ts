import { resolve } from 'node:path'
import type {
  AgentInstallation,
  DetectedSource,
  Host,
  NormalizedSourceOutput,
} from '@agent-lens/core'
import type { AgentLensContext } from '../context'
import {
  resolveDetectedSourceInstallation,
  resolveRuntimeHost,
} from '../source-sync'
import type {
  PiLivePackageUpdate,
  PiLivePackageUpdateCheckStatus,
  PiLiveStartupResources,
} from './types'

const PI_SOURCE_ID = 'pi'
export const PI_LIVE_STARTUP_AUDIT_PARSER_VERSION = 'pi-live-startup-audit-v1'

export interface PiLiveStartupAuditSnapshot {
  runtimeSessionId: string
  attemptStartedAt: string
  capturedAt: string
  nativeSessionId: string
  workspacePath: string
  startupResources: PiLiveStartupResources
  packageUpdateCheck?: Exclude<PiLivePackageUpdateCheckStatus, 'checking'> | undefined
  packageUpdates?: PiLivePackageUpdate[] | undefined
  packageUpdatesCheckedAt?: string | undefined
  executable?: string | undefined
  sdkVersion?: string | undefined
  sessionName?: string | undefined
}

export interface PiLiveStartupAuditSink {
  recordStartupAudit(snapshot: PiLiveStartupAuditSnapshot): Promise<void>
}

function executableKey(value: string | undefined): string {
  if (!value?.trim()) return ''
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function selectDetectedPi(
  detected: readonly DetectedSource[],
  executable: string | undefined,
): DetectedSource | undefined {
  const candidates = detected.filter(item =>
    item.sourceId === PI_SOURCE_ID && item.productId === PI_SOURCE_ID)
  if (!candidates.length) return undefined
  const expectedExecutable = executableKey(executable)
  if (!expectedExecutable) return candidates[0]
  return candidates.find(item => executableKey(item.executable) === expectedExecutable)
}

async function resolvePiInstallation(
  ctx: AgentLensContext,
  host: Host,
  snapshot: PiLiveStartupAuditSnapshot,
): Promise<AgentInstallation> {
  const source = ctx.sources.list().find(item => item.manifest.sourceId === PI_SOURCE_ID)
  if (!source) throw new Error('Pi Source is not registered; runtime startup cannot be audited')

  const detected = selectDetectedPi(
    await source.detect({
      host,
      env: snapshot.executable
        ? { ...process.env, PI_BIN: snapshot.executable }
        : process.env,
    }),
    snapshot.executable,
  )
  if (!detected) throw new Error('Pi Source did not detect the active Pi installation')

  return resolveDetectedSourceInstallation(ctx, host, detected)
}

function auditEventId(snapshot: PiLiveStartupAuditSnapshot): string {
  return `pi-live:${snapshot.runtimeSessionId}:startup-audit:${snapshot.attemptStartedAt}`
}

export function createPiLiveStartupAuditSink(ctx: AgentLensContext): PiLiveStartupAuditSink {
  return {
    async recordStartupAudit(snapshot) {
      if (!ctx.capturePolicy.isSourceEnabled(PI_SOURCE_ID)) return
      const host = await resolveRuntimeHost(ctx)
      const installation = await resolvePiInstallation(ctx, host, snapshot)
      const eventId = auditEventId(snapshot)
      const normalized: NormalizedSourceOutput = {
        observations: [{
          kind: 'runtime.startup',
          nativeEventId: eventId,
          occurredAt: snapshot.capturedAt,
          capturedAt: snapshot.capturedAt,
          payload: {
            schemaVersion: 1,
            event: 'runtime.startup.audit',
            runtimeSessionId: snapshot.runtimeSessionId,
            ...(snapshot.sdkVersion ? { sdkVersion: snapshot.sdkVersion } : {}),
            resources: snapshot.startupResources,
            ...(snapshot.packageUpdateCheck ? { packageUpdateCheck: snapshot.packageUpdateCheck } : {}),
            ...(snapshot.packageUpdates ? { packageUpdates: snapshot.packageUpdates } : {}),
            ...(snapshot.packageUpdatesCheckedAt ? { packageUpdatesCheckedAt: snapshot.packageUpdatesCheckedAt } : {}),
          },
          identityHints: {
            nativeSessionId: snapshot.nativeSessionId,
            workspacePath: snapshot.workspacePath,
            ...(snapshot.sessionName ? { sessionTitle: snapshot.sessionName } : {}),
          },
          dedupHints: {
            sharedEventKey: eventId,
          },
        }],
        evidenceCandidates: [{
          captureMethod: 'runtime-hook',
          derivation: 'observed',
          nativeStableId: eventId,
          sourceLocator: {
            kind: 'runtime-hook',
            hookEventId: eventId,
          },
          parserVersion: PI_LIVE_STARTUP_AUDIT_PARSER_VERSION,
          eventTime: snapshot.capturedAt,
          capturedAt: snapshot.capturedAt,
          confidenceHint: 'exact',
        }],
      }
      const persisted = ctx.capturePolicy.sanitizeNormalizedOutput(normalized)
      const observation = persisted.observations[0]
      if (!observation) return

      await ctx.observations.commit({
        sourceId: PI_SOURCE_ID,
        host,
        installation,
        candidate: observation,
        evidenceCandidates: persisted.evidenceCandidates,
      })
    },
  }
}

export const piLiveStartupAuditInternals = {
  selectDetectedPi,
  auditEventId,
}
