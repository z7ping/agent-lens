import type {
  AgentInstallation,
  Host,
  NormalizedSourceOutput,
  SourceNativeSessionPageQuery,
  SourceNativeSessionCursor,
} from '@agent-lens/core'

export type NativeWorkerSourceId = 'pi' | 'codex' | 'claude-code' | 'hermes' | 'opencode'

export interface NativeWorkerReadInput {
  sourceId: string
  parserVersion: string
  expectedFileIdentity: string
  query: SourceNativeSessionPageQuery
  host: Host
  installation: AgentInstallation
}

export interface NativeWorkerNormalizedRecord {
  recordId: string
  /** Exact source-owned rewind point, never a client file path. */
  recordCursor?: SourceNativeSessionCursor
  sourceId: string
  installationId: string
  sourceSessionNativeId?: string
  normalized: NormalizedSourceOutput
}

export type NativeWorkerReadResult =
  | {
      state: 'available'
      entries: NativeWorkerNormalizedRecord[]
      nextCursor: SourceNativeSessionCursor
      hasMore: boolean
      pendingTail: boolean
    }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

export type NativeWorkerRequest =
  | { kind: 'read'; id: number; input: NativeWorkerReadInput }
  | { kind: 'cancel'; id: number }

export interface NativeWorkerReply {
  kind: 'reply'
  id: number
  result: NativeWorkerReadResult
}
