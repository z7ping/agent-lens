import type {
  CapturePolicyService,
  CapturePolicySettings,
  CapturePolicyScope,
  CaptureValueOptions,
  CaptureValueResult,
  DiscoveredAsset,
  NormalizedSourceOutput,
  SourceRecord,
} from '@agent-lens/core'

/**
 * Source Runner 测试专用的直通采集策略。
 *
 * 生产代码仍必须注入正式 CapturePolicyService；这里仅用于测试固定装配，
 * 避免各 Source 测试重复实现隐私策略，同时不会把直通策略带入运行时。
 */
export function createTestCapturePolicy(enabledSources: readonly string[] = []): CapturePolicyService {
  const settings: Readonly<CapturePolicySettings> = Object.freeze({
    prompt: 'full',
    tool: 'full',
    config: 'full',
    environment: 'full',
    enabledSources: Object.freeze([...enabledSources]),
  })
  const enabled = new Set(enabledSources.map(sourceId => sourceId.toLowerCase()))

  return {
    settings,
    modeFor(_scope: CapturePolicyScope) {
      return 'full'
    },
    isEnabled(_scope: CapturePolicyScope) {
      return true
    },
    isSourceEnabled(sourceId: string) {
      return enabled.size === 0 || enabled.has(sourceId.toLowerCase())
    },
    capture<T>(
      _scope: CapturePolicyScope,
      value: T,
      _options?: CaptureValueOptions,
    ): CaptureValueResult<T> {
      return { value, mode: 'full', redactionApplied: false }
    },
    sanitizeSourceRecord(record: SourceRecord, _normalized?: NormalizedSourceOutput) {
      return record
    },
    sanitizeNormalizedOutput(normalized: NormalizedSourceOutput) {
      return normalized
    },
    sanitizeDiscoveredAsset(asset: DiscoveredAsset) {
      return asset
    },
  }
}
