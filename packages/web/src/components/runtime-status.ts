import type { HealthResponseDto } from '@agent-lens/protocol'

const runtimeOwnerLabel: Record<string, string> = {
  cli: '命令行',
  service: '后台服务',
  desktop: '桌面端',
  unknown: '未知来源',
}

const runtimeModeLabel: Record<string, string> = {
  foreground: '前台',
  managed: '托管',
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

export type RuntimeStatusTone = 'connecting' | 'healthy' | 'warning'

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
    ? '连接中'
    : health.status !== 'ok'
      ? '运行降级'
      : failedSourceStages > 0
        ? '来源异常'
        : liveConnected ? '运行正常' : '实时断开'
  const runtime = health?.runtime
  const owner = runtime ? runtimeOwnerLabel[runtime.owner] ?? runtime.owner : '等待 Runtime'
  const portSummary = endpoint.port ? `:${endpoint.port}` : ''

  return {
    tone: !health ? 'connecting' : healthy ? 'healthy' : 'warning',
    label,
    summary: runtime ? `${label} · ${owner}${portSummary}` : label,
    backend: !health ? '连接中' : health.status === 'ok' ? '正常' : '降级',
    live: liveConnected ? '已连接' : '未连接',
    owner,
    mode: runtime ? runtimeModeLabel[runtime.mode] ?? runtime.mode : '—',
    pid: runtime ? String(runtime.pid) : '—',
    startedAt: runtime?.startedAt ?? null,
    storage: !health ? '等待连接' : health.storage.ok ? '正常' : '异常',
    schema: health?.storage.schemaVersion === undefined ? '—' : String(health.storage.schemaVersion),
    failedSourceStages,
    unknownTotal,
    coverage: coverageSummary
      ? `完整 ${coverageComplete} · 部分 ${coveragePartial} · 来源不可用 ${coverageUnavailable} · 未知 ${coverageUnknown}`
      : null,
  }
}
