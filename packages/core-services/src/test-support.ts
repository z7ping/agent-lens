import type {
  CapturePolicyService,
  CapturePolicySettings,
  CapturePolicyScope,
  CapturePolicySourceConfiguration,
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
  let configuredEnabledSources = [...enabledSources]

  const settings = (): Readonly<CapturePolicySettings> => Object.freeze({
    prompt: 'full',
    tool: 'full',
    config: 'full',
    environment: 'full',
    enabledSources: Object.freeze([...configuredEnabledSources]),
  })

  const sourceConfiguration = (): CapturePolicySourceConfiguration => ({
    effectiveEnabledSources: [...configuredEnabledSources],
    configuredEnabledSources: [...configuredEnabledSources],
    source: 'runtime',
    editable: true,
    restartRequired: false,
  })

  return {
    get settings() {
      return settings()
    },
    modeFor(_scope: CapturePolicyScope) {
      return 'full'
    },
    isEnabled(_scope: CapturePolicyScope) {
      return true
    },
    isSourceEnabled(sourceId: string) {
      if (configuredEnabledSources.length === 0) return true
      const normalized = sourceId.toLowerCase()
      return configuredEnabledSources.some(value => value.toLowerCase() === normalized)
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
    getSourceConfiguration() {
      return sourceConfiguration()
    },
    async setEnabledSources(nextEnabledSources: readonly string[]) {
      configuredEnabledSources = [...nextEnabledSources]
      return sourceConfiguration()
    },
  }
}
