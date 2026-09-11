import type { HealthResponseDto } from '@agent-lens/protocol'
import { translateProduct } from '../i18n/runtime'

const runtimeOwnerKey: Record<string, string> = {
  cli: 'common:runtimeStatus.ownerCli',
  service: 'common:runtimeStatus.ownerService',
  desktop: 'common:runtimeStatus.ownerDesktop',
  unknown: 'common:runtimeStatus.ownerUnknown',
}

const runtimeModeKey: Record<string, string> = {
  foreground: 'common:runtimeStatus.modeForeground',
  managed: 'common:runtimeStatus.modeManaged',
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export interface RuntimeEndpointOptions {
  isDevelopment: boolean
  developmentPort: number
  protocol: string
  hostname: string
  port: string
}

export interface RuntimeEndpoint {
  origin: string
  port: number | null
}

export function resolveRuntimeEndpoint(options: RuntimeEndpointOptions): RuntimeEndpoint {
  if (options.isDevelopment) {
    return {
      origin: `http://127.0.0.1:${options.developmentPort}`,
      port: options.developmentPort,
    }
  }

  const explicitPort = Number(options.port)
  const port = Number.isInteger(explicitPort) && explicitPort > 0
    ? explicitPort
    : options.protocol === 'https:' ? 443 : options.protocol === 'http:' ? 80 : null
  const portSuffix = options.port ? `:${options.port}` : ''
  return {
    origin: `${options.protocol}//${options.hostname}${portSuffix}`,
    port,
  }
}

type RuntimeStatusTone = 'connecting' | 'healthy' | 'warning'

export interface RuntimeStatusView {
  tone: RuntimeStatusTone
  label: string
  summary: string
  backend: string
  live: string
  owner: string
  mode: string
  pid: string
  startedAt: string | null
  storage: string
  schema: string
  failedSourceStages: number
  unknownTotal: number
  coverage: string | null
}

export function projectRuntimeStatus(health: HealthResponseDto | null, liveConnected: boolean, endpoint: RuntimeEndpoint): RuntimeStatusView {
  const storageDetails = recordValue(health?.storage.details)
  const sourceRuntime = recordValue(storageDetails?.sourceRuntime)
  const unknownObservations = recordValue(storageDetails?.unknownObservations)
  const coverage = recordValue(storageDetails?.coverage)
  const coverageSummary = recordValue(coverage?.summary)
  const failedSourceStages = numberValue(sourceRuntime?.failed)
  const unknownTotal = numberValue(unknownObservations?.total)
  const coverageComplete = numberValue(coverageSummary?.complete)
  const coveragePartial = numberValue(coverageSummary?.partial)
  const coverageUnavailable = numberValue(coverageSummary?.unavailable)
  const coverageUnknown = numberValue(coverageSummary?.unknown)
  const healthy = health?.status === 'ok' && liveConnected && failedSourceStages === 0
  const label = !health
    ? translateProduct('common:runtimeStatus.connecting')
    : health.status !== 'ok'
      ? translateProduct('common:runtimeStatus.degraded')
      : failedSourceStages > 0
        ? translateProduct('common:runtimeStatus.sourceError')
        : liveConnected
          ? translateProduct('common:runtimeStatus.healthy')
          : translateProduct('common:runtimeStatus.liveDisconnected')
  const runtime = health?.runtime
  const owner = runtime
    ? runtimeOwnerKey[runtime.owner] ? translateProduct(runtimeOwnerKey[runtime.owner]!) : runtime.owner
    : translateProduct('common:runtimeStatus.waitingRuntime')
  const portSummary = endpoint.port ? `:${endpoint.port}` : ''

  return {
    tone: !health ? 'connecting' : healthy ? 'healthy' : 'warning',
    label,
    summary: runtime ? `${label} · ${owner}${portSummary}` : label,
    backend: !health
      ? translateProduct('common:runtimeStatus.connecting')
      : health.status === 'ok'
        ? translateProduct('common:runtimeStatus.backendHealthy')
        : translateProduct('common:runtimeStatus.backendDegraded'),
    live: liveConnected
      ? translateProduct('common:runtimeStatus.liveConnected')
      : translateProduct('common:runtimeStatus.liveDisconnectedState'),
    owner,
    mode: runtime
      ? runtimeModeKey[runtime.mode] ? translateProduct(runtimeModeKey[runtime.mode]!) : runtime.mode
      : '—',
    pid: runtime ? String(runtime.pid) : '—',
    startedAt: runtime?.startedAt ?? null,
    storage: !health
      ? translateProduct('common:runtimeStatus.storageWaiting')
      : health.storage.ok
        ? translateProduct('common:runtimeStatus.storageHealthy')
        : translateProduct('common:runtimeStatus.storageError'),
    schema: health?.storage.schemaVersion === undefined ? '—' : String(health.storage.schemaVersion),
    failedSourceStages,
    unknownTotal,
    coverage: coverageSummary
      ? translateProduct('common:runtimeStatus.coverage', {
          complete: coverageComplete,
          partial: coveragePartial,
          unavailable: coverageUnavailable,
          unknown: coverageUnknown,
        })
      : null,
  }
}
