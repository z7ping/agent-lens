import type { JsonValue } from './timeline'

export type PiLiveStreamingBehaviorDto = 'steer' | 'followUp'

export interface PiLiveAvailabilityDto {
  available: boolean
  executable?: string
  reason?: string
}

export interface PiLiveStartRequestDto {
  cwd: string
  executable?: string
  provider?: string
  model?: string
  name?: string
  sessionDir?: string
  sessionPath?: string
}

export interface PiLiveStateDto {
  runtimeSessionId: string
  nativeSessionId?: string
  sessionFile?: string
  sessionName?: string
  model?: JsonValue
  thinkingLevel?: string
  isStreaming: boolean
  isCompacting: boolean
  pendingMessageCount: number
  leafId?: string | null
  processId?: number
}

export interface PiLiveSnapshotDto {
  state: PiLiveStateDto
  entries: JsonValue[]
  leafId: string | null
}

export interface PiLivePromptRequestDto {
  message: string
  behavior?: PiLiveStreamingBehaviorDto
}

export interface PiLiveQueueDto {
  steering: string[]
  followUp: string[]
}

export interface PiLiveAbortRequestDto {
  restoreQueue?: boolean
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
