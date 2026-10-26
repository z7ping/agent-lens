import type {
  AgentInstallation,
  Host,
  RuntimeProfile,
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
  runtimeProfile?: RuntimeProfile
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

/** Hook archive requests carry only trusted Source + session identities,
 * not client paths or event bodies. The existing source adapter owns its inbox.
 */
export interface NativeWorkerHookReadInput {
  sourceId: string
  parserVersion: string
  nativeSessionId: string
  cursor?: string
  host: Host
  installation: AgentInstallation
  runtimeProfile?: RuntimeProfile
}

export type NativeWorkerHookReadResult =
  | {
      state: 'available'
      entries: NativeWorkerNormalizedRecord[]
      hasMore: boolean
      nextCursor?: string
    }
  | { state: 'unavailable' | 'drifted' | 'unsupported'; reason: string }

export type NativeWorkerRequest =
  | { kind: 'read'; id: number; input: NativeWorkerReadInput }
  | { kind: 'read-hooks'; id: number; input: NativeWorkerHookReadInput }
  | { kind: 'cancel'; id: number }

export type NativeWorkerReply =
  | { kind: 'reply'; id: number; result: NativeWorkerReadResult }
  | { kind: 'hook-reply'; id: number; result: NativeWorkerHookReadResult }
