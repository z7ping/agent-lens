import type {
  CapturePolicyMode,
  CapturePolicyScope,
  CapturePolicyService,
  CapturePolicySourceConfiguration,
  CapturePolicySettings,
  CaptureValueOptions,
  CaptureValueResult,
  DiscoveredAsset,
  NormalizedSourceOutput,
  ObservationCandidate,
  ObservationKind,
  SourceRecord,
} from '@agent-lens/core'

export const REDACTED = '[已脱敏]'
export const NOT_CAPTURED = '[未采集：隐私策略关闭]'
export const DEFAULT_ENABLED_SOURCES = ['claude-code'] as const

const DEFAULT_MAX_TEXT: Record<CapturePolicyScope, number> = {
  prompt: 20_000,
  tool: 4_000,
  config: 4_000,
  environment: 1_000,
}

const FULL_MAX_TEXT: Record<CapturePolicyScope, number> = {
  prompt: 64_000,
  tool: 20_000,
  config: 20_000,
  environment: 4_000,
}

const MAX_ARRAY_ITEMS = 100
const MAX_OBJECT_KEYS = 100

const SENSITIVE_KEY = /(?:^|[_-])(authorization|cookie|set-cookie|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credential|credentials)(?:$|[_-])/i
const SENSITIVE_KEY_SUFFIX = /(?:authorization|cookie|cookies|password|passwd|pwd|secret|token|apikey|accesskey|privatekey|clientsecret|credential|credentials)$/

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEY.test(key)) return true
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return SENSITIVE_KEY_SUFFIX.test(normalized)
}

const TOOL_OFF_SAFE_KEYS = new Set([
  'nativeToolName', 'toolName', 'tool_name', 'name', 'type', 'event', 'status',
  'success', 'durationMs', 'duration_ms', 'exitCode', 'exit_code', 'callId',
  'call_id', 'toolCallId', 'tool_call_id', 'nativeCallId', 'native_call_id',
  'decision', 'permissionMode', 'permission_mode',
])

function normalizeMode(value: unknown, fallback: CapturePolicyMode): CapturePolicyMode {
  const mode = String(value ?? '').trim().toLowerCase()
  return mode === 'off' || mode === 'redacted' || mode === 'full'
    ? mode
    : fallback
}

function normalizeSourceId(value: unknown): string {
  return String(value ?? '').trim().toLowerCase()
}

export function normalizeEnabledSources(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeSourceId).filter(Boolean))]
}

export function enabledSourcesFromEnv(value: string | undefined): string[] {
  const raw = String(value ?? '').trim()
  if (!raw) return [...DEFAULT_ENABLED_SOURCES]
  if (raw.toLowerCase() === 'none') return []
  return normalizeEnabledSources(raw.split(','))
}

export function capturePolicySettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): CapturePolicySettings {
  return {
    prompt: normalizeMode(env.AGENT_LENS_PROMPT_CAPTURE, 'redacted'),
    tool: normalizeMode(env.AGENT_LENS_TOOL_CAPTURE, 'redacted'),
    config: normalizeMode(env.AGENT_LENS_CONFIG_CAPTURE, 'redacted'),
    environment: normalizeMode(env.AGENT_LENS_ENV_CAPTURE, 'off'),
    enabledSources: enabledSourcesFromEnv(env.AGENT_LENS_ENABLED_SOURCES),
  }
}

function hardRedactText(input: string): { value: string; changed: boolean } {
  const original = input
  const value = input
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, `Basic ${REDACTED}`)
    .replace(/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{12,}\b/g, REDACTED)
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/gi, REDACTED)
    .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}\b/gi, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/([?&](?:token|access_token|api_key|key|secret|password)=)[^&#\s]+/gi, `$1${encodeURIComponent(REDACTED)}`)
    .replace(/\b(authorization|cookie|password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*([^\s,;]+)/gi, `$1=${REDACTED}`)
  return { value, changed: value !== original }
}

function privacyRedactText(input: string): { value: string; changed: boolean } {
  const hard = hardRedactText(input)
  const value = hard.value
    .replace(/\b([A-Za-z]:\\Users\\)[^\\\s]+/gi, '$1[用户]')
    .replace(/\/Users\/[^/\s]+/g, '/Users/[用户]')
    .replace(/\/home\/[^/\s]+/g, '/home/[用户]')
  return { value, changed: hard.changed || value !== hard.value }
}

interface SanitizeOptions {
  redacted: boolean
  maxText: number
}

function sanitizeValue(
  input: unknown,
  options: SanitizeOptions,
  seen = new WeakSet<object>(),
): { value: unknown; changed: boolean } {
  if (input === null || input === undefined) return { value: input, changed: false }
  if (typeof input === 'string') {
    const truncated = input.length > options.maxText ? input.slice(0, options.maxText) : input
    const sanitized = options.redacted ? privacyRedactText(truncated) : hardRedactText(truncated)
    return {
      value: sanitized.value,
      changed: sanitized.changed || truncated.length !== input.length,
    }
  }
  if (typeof input === 'number' || typeof input === 'boolean') return { value: input, changed: false }
  if (typeof input !== 'object') return { value: String(input), changed: true }
  if (seen.has(input)) return { value: '[循环引用]', changed: true }
  seen.add(input)

  let changed = false
  if (Array.isArray(input)) {
    const selected = input.slice(0, MAX_ARRAY_ITEMS)
    const value = selected.map(item => {
      const result = sanitizeValue(item, options, seen)
      changed ||= result.changed
      return result.value
    })
    if (selected.length !== input.length) changed = true
    seen.delete(input)
    return { value, changed }
  }

  const entries = Object.entries(input as Record<string, unknown>).slice(0, MAX_OBJECT_KEYS)
  const value: Record<string, unknown> = {}
  for (const [key, item] of entries) {
    if (isSensitiveKey(key)) {
      value[key] = REDACTED
      changed = true
      continue
    }
    const result = sanitizeValue(item, options, seen)
    value[key] = result.value
    changed ||= result.changed
  }
  if (entries.length !== Object.keys(input as object).length) changed = true
  seen.delete(input)
  return { value, changed }
}

function observationScopes(kind: ObservationKind): CapturePolicyScope[] {
  if (kind === 'message.user' || kind === 'message.assistant' || kind === 'message.commentary' || kind === 'message.reasoning' || kind === 'context.summary' || kind === 'context.injected') {
    return ['prompt']
  }
  if (kind === 'tool.call' || kind === 'tool.progress' || kind === 'tool.result'
    || kind === 'permission.request' || kind === 'permission.response' || kind === 'artifact.action') {
    return ['tool']
  }
  if (kind === 'unknown') return ['prompt', 'tool']
  return []
}

function strictestMode(modes: CapturePolicyMode[]): CapturePolicyMode {
  if (modes.includes('off')) return 'off'
  if (modes.includes('redacted')) return 'redacted'
  return 'full'
}

function offToolPayload(payload: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = { capturePolicy: 'off' }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return result
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (!TOOL_OFF_SAFE_KEYS.has(key)) continue
    result[key] = sanitizeValue(value, { redacted: false, maxText: 512 }).value
  }
  return result
}

function offPayload(kind: ObservationKind, payload: unknown): unknown {
  const scopes = observationScopes(kind)
  if (scopes.includes('tool')) return offToolPayload(payload)
  if (scopes.includes('prompt')) return { capturePolicy: 'off', text: NOT_CAPTURED }
  return { capturePolicy: 'off' }
}

function structuralValue(value: unknown, maxText = 4_000): unknown {
  return sanitizeValue(value, { redacted: false, maxText }).value
}

export class DefaultCapturePolicyService implements CapturePolicyService {
  readonly settings: Readonly<CapturePolicySettings>
  private readonly enabledSourceIds: ReadonlySet<string>
  private configuredEnabledSources: readonly string[]

  constructor(
    settings: CapturePolicySettings,
    private readonly sourceConfiguration: Omit<CapturePolicySourceConfiguration, 'effectiveEnabledSources' | 'configuredEnabledSources' | 'restartRequired'> & {
      configuredEnabledSources?: readonly string[]
      writeEnabledSources?: (enabledSources: readonly string[]) => Promise<void>
    } = { source: 'runtime', editable: false },
  ) {
    const enabledSources = Object.freeze(normalizeEnabledSources(settings.enabledSources))
    this.settings = Object.freeze({ ...settings, enabledSources })
    this.enabledSourceIds = new Set(enabledSources)
    this.configuredEnabledSources = Object.freeze(normalizeEnabledSources(
      sourceConfiguration.configuredEnabledSources ?? enabledSources,
    ))
  }

  modeFor(scope: CapturePolicyScope): CapturePolicyMode {
    return this.settings[scope]
  }

  isEnabled(scope: CapturePolicyScope): boolean {
    return this.modeFor(scope) !== 'off'
  }

  isSourceEnabled(sourceId: string): boolean {
    return this.enabledSourceIds.has(normalizeSourceId(sourceId))
  }

  capture<T>(
    scope: CapturePolicyScope,
    value: T,
    options: CaptureValueOptions = {},
  ): CaptureValueResult<T> {
    const mode = this.modeFor(scope)
    if (mode === 'off') {
      return { value: null, mode, redactionApplied: value !== null && value !== undefined }
    }
    const maxText = options.maxText ?? (mode === 'full' ? FULL_MAX_TEXT[scope] : DEFAULT_MAX_TEXT[scope])
    const result = sanitizeValue(value, { redacted: mode === 'redacted' && scope !== 'config', maxText })
    return {
      value: result.value as T,
      mode,
      redactionApplied: result.changed,
    }
  }

  sanitizeSourceRecord(record: SourceRecord, normalized?: NormalizedSourceOutput): SourceRecord {
    const scopes = normalized
      ? [...new Set(normalized.observations.flatMap(item => observationScopes(item.kind)))]
      : ['prompt', 'tool'] satisfies CapturePolicyScope[]
    if (!scopes.length) {
      return { ...record, payload: structuralValue(record.payload) }
    }
    const mode = strictestMode(scopes.map(scope => this.modeFor(scope)))
    if (mode === 'off') return { ...record, payload: null }
    const maxText = Math.min(...scopes.map(scope => mode === 'full' ? FULL_MAX_TEXT[scope] : DEFAULT_MAX_TEXT[scope]))
    return {
      ...record,
      payload: sanitizeValue(record.payload, { redacted: mode === 'redacted', maxText }).value,
    }
  }

  sanitizeNormalizedOutput(normalized: NormalizedSourceOutput): NormalizedSourceOutput {
    const observations: ObservationCandidate[] = normalized.observations.map(observation => {
      const scopes = observationScopes(observation.kind)
      if (!scopes.length) {
        return { ...observation, payload: structuralValue(observation.payload) }
      }
      const mode = strictestMode(scopes.map(scope => this.modeFor(scope)))
      if (mode === 'off') return { ...observation, payload: offPayload(observation.kind, observation.payload) }
      const maxText = Math.min(...scopes.map(scope => mode === 'full' ? FULL_MAX_TEXT[scope] : DEFAULT_MAX_TEXT[scope]))
      return {
        ...observation,
        payload: sanitizeValue(observation.payload, { redacted: mode === 'redacted', maxText }).value,
      }
    })

    const assetHints = normalized.assetHints
      ? (this.capture('config', normalized.assetHints).value ?? [])
      : undefined

    return {
      ...normalized,
      observations,
      evidenceCandidates: structuralValue(normalized.evidenceCandidates) as NormalizedSourceOutput['evidenceCandidates'],
      ...(normalized.coverage
        ? { coverage: structuralValue(normalized.coverage) as NonNullable<NormalizedSourceOutput['coverage']> }
        : {}),
      ...(assetHints === undefined ? {} : { assetHints: assetHints as unknown[] }),
      ...(normalized.sessionRelationshipHints
        ? {
            sessionRelationshipHints: structuralValue(
              normalized.sessionRelationshipHints,
            ) as NonNullable<NormalizedSourceOutput['sessionRelationshipHints']>,
          }
        : {}),
    }
  }

  sanitizeDiscoveredAsset(asset: DiscoveredAsset): DiscoveredAsset | null {
    if (!this.isEnabled('config')) return null
    const captured = this.capture('config', asset)
    return captured.value as DiscoveredAsset | null
  }

  getSourceConfiguration(): CapturePolicySourceConfiguration {
    const effectiveEnabledSources = this.settings.enabledSources
    const configuredEnabledSources = this.configuredEnabledSources
    return {
      effectiveEnabledSources,
      configuredEnabledSources,
      source: this.sourceConfiguration.source,
      editable: this.sourceConfiguration.editable,
      restartRequired: effectiveEnabledSources.join('\u0000') !== configuredEnabledSources.join('\u0000'),
      ...(this.sourceConfiguration.configurationPath
        ? { configurationPath: this.sourceConfiguration.configurationPath }
        : {}),
    }
  }

  async setEnabledSources(enabledSources: readonly string[]): Promise<CapturePolicySourceConfiguration> {
    if (!this.sourceConfiguration.editable || !this.sourceConfiguration.writeEnabledSources) {
      throw new Error('当前来源采集策略由环境变量或运行时配置管理，不能从 AgentLens 界面修改')
    }
    const normalized = normalizeEnabledSources(enabledSources)
    await this.sourceConfiguration.writeEnabledSources(normalized)
    this.configuredEnabledSources = Object.freeze(normalized)
    return this.getSourceConfiguration()
  }
}

export const capturePolicyInternals = {
  normalizeMode,
  normalizeSourceId,
  isSensitiveKey,
  hardRedactText,
  privacyRedactText,
  observationScopes,
  strictestMode,
  offPayload,
}
