import type { JsonValue } from './timeline'

export type PiLiveStreamingBehaviorDto = 'steer' | 'followUp'
export type PiLiveRuntimeStatusDto = 'initializing' | 'ready' | 'failed' | 'terminating' | 'terminated'
export type PiLiveInitializationStageDto = 'starting_worker' | 'loading_sdk' | 'loading_resources' | 'creating_session' | 'binding_extensions' | 'ready'
export type PiLiveResumeActionDto = 'continue' | 'fork'

export interface PiLiveInitializationTimingDto {
  stage: PiLiveInitializationStageDto
  durationMs: number
}

export interface PiLiveStartupResourcesDto {
  contexts: string[]
  skills: string[]
  prompts: string[]
  extensions: string[]
  themes: string[]
  diagnostics: string[]
}

export interface PiLiveRuntimeCapabilitiesDto {
  protocolVersion: number
  sdkVersion?: string | undefined
  sessionRuntime: boolean
  modelSwitching: boolean
  thinkingLevelControl: boolean
  extensionUi: boolean
}

export interface PiLiveAvailabilityDto {
  available: boolean
  executable?: string | undefined
  reason?: string | undefined
}

/** Public new-task input. Native session paths are intentionally server-only. */
export interface PiLiveStartRequestDto {
  cwd: string
  executable?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  name?: string | undefined
}

export interface PiLiveResumeRequestDto {
  logicalSessionId: string
  action: PiLiveResumeActionDto
}

export interface PiLiveModelOptionDto {
  provider: string
  id: string
  name?: string | undefined
  reasoning?: boolean | undefined
}

export interface PiLiveControlsDto {
  models: PiLiveModelOptionDto[]
  thinkingLevels: string[]
}

export interface PiLiveSetModelRequestDto {
  provider: string
  modelId: string
}

export interface PiLiveSetThinkingLevelRequestDto {
  level: string
}

export interface PiLiveStateDto {
  runtimeSessionId: string
  status: PiLiveRuntimeStatusDto
  initializationStage?: PiLiveInitializationStageDto | undefined
  initializationMessage?: string | undefined
  initializationElapsedMs?: number | undefined
  initializationTimings?: PiLiveInitializationTimingDto[] | undefined
  startupResources?: PiLiveStartupResourcesDto | undefined
  startupOutput?: string[] | undefined
  capabilities?: PiLiveRuntimeCapabilitiesDto | undefined
  error?: string | undefined
  sdkVersion?: string | undefined
  runtimeMode?: 'session_runtime' | 'compatibility' | undefined
  nativeSessionId?: string | undefined
  sessionName?: string | undefined
  model?: JsonValue | undefined
  thinkingLevel?: string | undefined
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  leafId?: string | null | undefined
  processId?: number | undefined
}

export interface PiLiveSnapshotDto {
  state: PiLiveStateDto
  entries: JsonValue[]
  leafId: string | null
}

export interface PiLivePromptRequestDto {
  message: string
  behavior?: PiLiveStreamingBehaviorDto | undefined
}

export interface PiLiveQueueDto {
  steering: string[]
  followUp: string[]
}

export interface PiLiveAbortRequestDto {
  restoreQueue?: boolean | undefined
}

export interface PiLiveExtensionResponseRequestDto {
  requestId: string
  response: JsonValue
}

export interface PiLiveEventDto {
  runtimeSessionId: string
  sequence: number
  receivedAt: string
  event: { [key: string]: JsonValue }
}

function piLiveEventRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function piLiveJsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map((item, index) => piLiveJsonValue(item, `${label}[${index}]`))
  if (value && typeof value === 'object') {
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = piLiveJsonValue(item, `${label}.${key}`)
    }
    return result
  }
  throw new TypeError(`${label} must contain JSON data`)
}

export function parsePiLiveEvent(value: unknown): PiLiveEventDto {
  const record = piLiveEventRecord(value, 'Pi Live event')
  const runtimeSessionId = record.runtimeSessionId
  const sequence = record.sequence
  const receivedAt = record.receivedAt
  if (typeof runtimeSessionId !== 'string' || !runtimeSessionId) {
    throw new TypeError('Pi Live event runtimeSessionId must be a non-empty string')
  }
  if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new TypeError('Pi Live event sequence must be a non-negative safe integer')
  }
  if (typeof receivedAt !== 'string' || !receivedAt) {
    throw new TypeError('Pi Live event receivedAt must be a non-empty string')
  }
  const event = piLiveJsonValue(record.event, 'Pi Live event payload')
  if (!event || Array.isArray(event) || typeof event !== 'object') {
    throw new TypeError('Pi Live event payload must be an object')
  }
  return { runtimeSessionId, sequence, receivedAt, event }
}
