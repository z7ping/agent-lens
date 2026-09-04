import type { JsonValue, TimelineSourceLocatorDto } from './timeline'

/** Safe source record exposed only on explicit Raw Inspector demand. */
export interface SourceRecordResponseDto {
  id: string
  sourceId: string
  installationId: string
  sourceSessionNativeId?: string
  nativeType: string
  nativeId?: string
  sourceSequence?: number
  occurredAt?: string
  capturedAt: string
  locator: TimelineSourceLocatorDto
  fingerprint?: string
  payload: JsonValue
  parserVersion: string
}
