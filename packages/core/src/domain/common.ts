export type HostId = string
export type AgentProductId = string
export type AgentInstallationId = string
export type AgentActorId = string
export type ProjectId = string
export type WorkspaceId = string
export type LogicalSessionId = string
export type SourceSessionId = string
export type InteractionId = string
export type SourceRecordId = string
export type ObservationId = string
export type EvidenceId = string
export type CoverageId = string
export type AssetDefinitionId = string
export type AssetBindingId = string
export type ToolDefinitionId = string
export type FindingId = string

export type Confidence = 'exact' | 'high' | 'medium' | 'low' | 'unknown'

export type CaptureMethod =
  | 'runtime-hook'
  | 'native-log'
  | 'native-db'
  | 'static-scan'
  | 'external-import'

export type Derivation =
  | 'observed'
  | 'reported'
  | 'derived'
  | 'estimated'
  | 'inferred'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface Disposable {
  dispose(): void | Promise<void>
}
