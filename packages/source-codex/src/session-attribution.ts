import type {
  NormalizedSourceOutput,
  SessionActivityKind,
  SessionRelationshipCandidate,
  SessionRelationshipType,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function lowerText(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase()
  try { return JSON.stringify(value ?? '').toLowerCase() } catch { return '' }
}

function sessionMeta(record: SourceRecord): {
  entry: Record<string, unknown>
  payload: Record<string, unknown>
  nativeSessionId: string
} | null {
  const envelope = asRecord(record.payload)
  const entry = asRecord(envelope.entry)
  if (entry.type !== 'session_meta') return null
  const payload = asRecord(entry.payload)
  const session = asRecord(envelope.session)
  const nativeSessionId = stringField(payload, 'id')
    ?? stringField(session, 'nativeSessionId')
    ?? record.sourceSessionNativeId
  return nativeSessionId ? { entry, payload, nativeSessionId } : null
}

function subagentParts(payload: Record<string, unknown>) {
  const source = asRecord(payload.source)
  const raw = source.subagent ?? source.subAgent
  const subagent = asRecord(raw)
  const spawn = asRecord(subagent.thread_spawn ?? subagent.threadSpawn)
  const threadSource = payload.thread_source ?? payload.threadSource
  return { source, raw, subagent, spawn, threadSource }
}

function directParentId(payload: Record<string, unknown>): string | undefined {
  const { source, subagent, spawn } = subagentParts(payload)
  const threadSource = asRecord(payload.thread_source ?? payload.threadSource)
  return stringField(payload, 'parent_thread_id', 'parent_session_id', 'forked_from_id')
    ?? stringField(spawn, 'parent_thread_id', 'parent_session_id')
    ?? stringField(subagent, 'parent_thread_id', 'parent_session_id')
    ?? stringField(threadSource, 'parent_thread_id', 'parent_session_id')
    ?? stringField(source, 'parent_thread_id', 'parent_session_id')
}

function rootTaskId(payload: Record<string, unknown>, ownSessionId: string): string | undefined {
  const root = stringField(payload, 'session_id', 'root_session_id')
  return root && root !== ownSessionId ? root : undefined
}

function guardianReview(payload: Record<string, unknown>): boolean {
  const { raw, subagent, spawn, threadSource } = subagentParts(payload)
  const values = [raw, subagent, spawn, threadSource, payload.agent_role, payload.agentRole]
    .map(lowerText)
    .join('\n')
  return /guardian[_-]?review/.test(values)
    || /(^|["\s:_-])guardian(["\s:_-]|$)/.test(values)
    || (typeof raw === 'string' && raw.toLowerCase() === 'review')
}

function subagentLabel(payload: Record<string, unknown>): string | undefined {
  const { raw, subagent, spawn } = subagentParts(payload)
  if (guardianReview(payload)) return 'Guardian 审查'
  return stringField(spawn, 'agent_nickname', 'agent_path', 'agent_role')
    ?? stringField(subagent, 'agent_nickname', 'agent_path', 'agent_role', 'name', 'type', 'other')
    ?? (typeof raw === 'string' && raw !== 'review' ? raw : undefined)
}

function classifySession(payload: Record<string, unknown>): {
  activity: SessionActivityKind
  relationship: SessionRelationshipType
  sourceLabel?: string
} {
  const { raw, subagent, threadSource } = subagentParts(payload)
  if (guardianReview(payload)) {
    return { activity: 'internal-review', relationship: 'internal-review', sourceLabel: 'Guardian 审查' }
  }
  if (stringField(payload, 'forked_from_id')) {
    return { activity: 'branch-task', relationship: 'branch-task', sourceLabel: '分支任务' }
  }

  const role = lowerText(payload.agent_role ?? payload.agentRole ?? subagent.agent_role ?? subagent.role)
  const sourceText = lowerText(threadSource)
  const rawText = lowerText(raw)
  // Codex 官方持久化契约中 parent_thread_id 只会设置在子 Agent 线程上。
  // 因此即使旧版 session_meta 缺少 thread_source/subagent 细节，也不能降级为泛化“系统活动”。
  const isSubagent = Boolean(directParentId(payload))
    || sourceText.includes('subagent')
    || raw !== undefined
    || rawText.includes('subagent')
    || /worker|subagent|child/.test(role)
  if (isSubagent) {
    const sourceLabel = subagentLabel(payload)
    return sourceLabel
      ? { activity: 'subagent', relationship: 'subagent', sourceLabel }
      : { activity: 'subagent', relationship: 'subagent' }
  }

  if (rootTaskId(payload, stringField(payload, 'id') ?? '')) {
    return { activity: 'system-activity', relationship: 'related' }
  }
  return { activity: 'user-task', relationship: 'related' }
}

function relationship(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  fromNativeSessionId: string,
  toNativeSessionId: string,
  type: SessionRelationshipType,
  nativeRelation: string,
): SessionRelationshipCandidate {
  return {
    sourceId: 'codex',
    installationId: record.installationId,
    ...(ctx.runtimeProfile?.id ? { runtimeProfileId: ctx.runtimeProfile.id } : {}),
    fromNativeSessionId,
    toNativeSessionId,
    type,
    nativeRelation,
    confidence: 'exact',
  }
}

/**
 * Codex 的 session_meta 在版本间出现过多种 parent/source 形态。
 * normalize.ts 负责通用事件解析；这里集中做会话归属修正，避免 UI 再猜。
 */
export function normalizeCodexSessionAttribution(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
  output: NormalizedSourceOutput,
): NormalizedSourceOutput {
  const meta = sessionMeta(record)
  if (!meta) return output

  const ownSessionId = meta.nativeSessionId
  const directParent = directParentId(meta.payload)
  const rootTask = rootTaskId(meta.payload, ownSessionId)
  const parentSessionId = directParent ?? rootTask
  const classification = classifySession(meta.payload)
  const orphanInternalActivity = classification.activity !== 'user-task' && !directParent && !rootTask

  const observations = output.observations.map(observation => {
    if (observation.kind !== 'session.lifecycle') return observation
    const payload = asRecord(observation.payload)
    if (payload.event !== 'session.discovered') return observation
    return {
      ...observation,
      payload: {
        ...payload,
        sessionActivity: classification.activity,
        ...(classification.sourceLabel ? { activitySourceLabel: classification.sourceLabel } : {}),
        sessionId: ownSessionId,
        ...(rootTask ? { rootSessionId: rootTask } : {}),
        ...(directParent ? { parentSessionId: directParent } : {}),
        ...(orphanInternalActivity ? { orphanInternalActivity: true } : {}),
      },
      ...(parentSessionId
        ? { identityHints: { ...observation.identityHints, nativeParentSessionId: parentSessionId } }
        : observation.identityHints
          ? { identityHints: observation.identityHints }
          : {}),
    }
  })

  const relationships: SessionRelationshipCandidate[] = []
  if (rootTask && rootTask !== ownSessionId) {
    relationships.push(relationship(record, ctx, rootTask, ownSessionId, 'task-root', 'session_id'))
  }
  if (directParent && directParent !== ownSessionId) {
    relationships.push(relationship(
      record,
      ctx,
      directParent,
      ownSessionId,
      classification.relationship,
      stringField(meta.payload, 'forked_from_id')
        ? 'forked_from_id'
        : asRecord(subagentParts(meta.payload).spawn).parent_thread_id
          ? 'source.subagent.thread_spawn.parent_thread_id'
          : 'parent_thread_id',
    ))
  }

  return {
    ...output,
    observations,
    ...(relationships.length ? { sessionRelationshipHints: relationships } : { sessionRelationshipHints: [] }),
  }
}
