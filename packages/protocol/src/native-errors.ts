/** Searchable, source-derived error summaries. Full tool output stays native. */
export interface NativeErrorIndexItemDto {
  eventKey:string
  sessionId:string
  sourceId:string
  occurredAt:string
  turnOrdinal:number|null
  nativeEventId:string|null
  toolName:string|null
  kind:'tool'|'runtime'
  errorCode:string|null
  summary:string
  fingerprint:string
  coverage:'complete'|'partial'
}
export interface NativeErrorIndexResponseDto {
  items:NativeErrorIndexItemDto[]
  total:number
  hasMore:boolean
  eligibleSessions:number
  readySessions:number
}
