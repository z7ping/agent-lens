import type { JsonValue } from './timeline'

export type PiLiveStreamingBehaviorDto = 'steer' | 'followUp'

export interface PiLiveAvailabilityDto {
  available: boolean
  executable?: string | undefined
  reason?: string | undefined
}

export interface PiLiveStartRequestDto {
  cwd: string
  executable?: string | undefined
  provider?: string | undefined
  model?: string | undefined
  name?: string | undefined
  sessionDir?: string | undefined
  sessionPath?: string | undefined
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
  nativeSessionId?: string | undefined
  sessionFile?: string | undefined
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
