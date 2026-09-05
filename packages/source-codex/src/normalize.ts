import type {
  EvidenceCandidate,
  JsonValue,
  NormalizedSourceOutput,
  ObservationCandidate,
  ObservationIdentityHints,
  SessionRelationshipType,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import {
  messageText,
  parseFunctionOutput,
  type CodexStoredEnvelope,
} from './format'
import {
  assistantMessageProvenance,
  attachmentMetadata,
  contextClassification,
  isGuardianSource,
  userMessageProvenance,
} from './provenance'

const TRAILING_MEMORY_CITATION = /(?:\r?\n){0,2}<oai-mem-citation>\s*<citation_entries>[\s\S]*?<\/citation_entries>\s*<rollout_ids>[\s\S]*?<\/rollout_ids>\s*<\/oai-mem-citation>\s*$/i
const CLIENT_DIRECTIVE_LINE = /^::(?:created-thread|code-comment)\{[^\r\n]*\}\s*$/gm

export function splitCodexVisibleAssistantText(text: string, phase?: string): {
  text: string
  sourceMetadata?: Array<{ kind: 'memory.citation' | 'client.directive' }>
} {
  if (phase !== 'final_answer') return { text }
  const match = TRAILING_MEMORY_CITATION.exec(text)
  const prefix = match && match.index !== undefined ? text.slice(0, match.index) : text
  const fenceCount = prefix.match(/```/g)?.length ?? 0
  if (fenceCount % 2 !== 0) return { text }
  const withoutDirectives = prefix.replace(CLIENT_DIRECTIVE_LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd()
  const metadata = [
    ...(match ? [{ kind: 'memory.citation' as const }] : []),
    ...(withoutDirectives !== prefix ? [{ kind: 'client.directive' as const }] : []),
  ]
  if (!match && !metadata.length) return { text }
  return {
    text: withoutDirectives,
    sourceMetadata: metadata,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(record: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function numberField(record: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = record[name]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function actorRole(value: unknown): NonNullable<ObservationIdentityHints['actorRole']> {
  const role = typeof value === 'string' ? value.toLowerCase() : ''
  if (role.includes('worker')) return 'worker-agent'
  if (role.includes('sub') || role.includes('child') || role.includes('review')) return 'subagent'
  if (role.includes('main') || role.includes('root')) return 'main-agent'
  return 'unknown'
}

function tokenUsage(payload: Record<string, unknown>): Record<string, unknown> {
  const info = asRecord(payload.info)
  const total = asRecord(info.total_token_usage ?? payload.total_token_usage ?? payload.usage ?? payload)
  const last = asRecord(info.last_token_usage ?? payload.last_token_usage)
  const inputTokens = numberField(total, 'input_tokens', 'inputTokens') ?? 0
  const cacheReadTokens = numberField(total, 'cached_input_tokens', 'cache_read_tokens', 'cacheReadTokens') ?? 0
  const outputTokens = numberField(total, 'output_tokens', 'outputTokens') ?? 0
  const reasoningOutputTokens = numberField(total, 'reasoning_output_tokens', 'reasoningOutputTokens') ?? 0
  const totalTokens = numberField(total, 'total_tokens', 'totalTokens') ?? inputTokens + outputTokens
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    totalTokens,
    ...(reasoningOutputTokens ? { reasoningOutputTokens } : {}),
    ...(Object.keys(last).length ? { lastTokenUsage: last } : {}),
    raw: payload,
  }
}

const visibleReasoningTypes = new Set([
  'agent_reasoning',
  'reasoning',
  'reasoning_summary',
])

function visibleReasoningText(payload: Record<string, unknown>): string {
  for (const value of [
    payload.text,
    payload.message,
    payload.reasoning,
    payload.summary,
    payload.content,
  ]) {
    const text = messageText(value).trim()
    if (text) return text
  }
  return ''
}

function sourceSubagent(payload: Record<string, unknown>): Record<string, unknown> {
  const source = asRecord(payload.source)
  return asRecord(source.subagent ?? source.subAgent)
}

function parentThreadId(payload: Record<string, unknown>): string | undefined {
  const threadSource = asRecord(payload.thread_source)
  const source = asRecord(payload.source)
  const subagent = sourceSubagent(payload)
  return stringField(payload, 'forked_from_id', 'parent_thread_id', 'parent_session_id')
    ?? stringField(threadSource, 'parent_thread_id', 'parent_session_id')
    ?? stringField(source, 'parent_thread_id', 'parent_session_id')
    ?? stringField(subagent, 'parent_thread_id', 'parent_session_id')
}

function sessionActivity(payload: Record<string, unknown>): {
  kind: 'user-task' | 'branch-task' | 'subagent' | 'internal-review' | 'system-activity'
  relationship: SessionRelationshipType
  sourceLabel?: string
} {
  const source = payload.source
  const threadSource = payload.thread_source
  const subagent = sourceSubagent(payload)
  if (isGuardianSource(source) || isGuardianSource(subagent) || isGuardianSource(payload.agent_role)) {
    return { kind: 'internal-review', relationship: 'internal-review', sourceLabel: 'Guardian 审查' }
  }
  if (stringField(payload, 'forked_from_id')) {
    return { kind: 'branch-task', relationship: 'branch-task', sourceLabel: '分支任务' }
  }
  const threadSourceText = typeof threadSource === 'string' ? threadSource.toLowerCase() : ''
  const subagentName = stringField(subagent, 'other', 'name', 'type')
  const role = actorRole(payload.agent_role ?? subagent.agent_role ?? subagent.role)
  if (threadSourceText === 'subagent' || Object.keys(subagent).length > 0 || role === 'subagent' || role === 'worker-agent') {
    return { kind: 'subagent', relationship: 'subagent', ...(subagentName ? { sourceLabel: subagentName } : {}) }
  }
  if (parentThreadId(payload)) return { kind: 'system-activity', relationship: 'related' }
  return { kind: 'user-task', relationship: 'related' }
}

function evidenceFor(record: SourceRecord): EvidenceCandidate {
  const runtime = record.locator.kind === 'runtime-hook'
  return {
    captureMethod: runtime ? 'runtime-hook' : 'native-log',
    derivation: runtime ? 'observed' : 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: record.nativeId ? 'exact' : 'high',
  }
}

function identityHints(record: SourceRecord, envelope: CodexStoredEnvelope): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
    ...(envelope.session.title?.trim() ? { sessionTitle: envelope.session.title.trim() } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: CodexStoredEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  dedup: Partial<NonNullable<ObservationCandidate['dedupHints']>> = {},
  extraIdentity: Partial<ObservationIdentityHints> = {},
): ObservationCandidate {
  return {
    kind,
    ...(record.nativeId ? { nativeEventId: record.nativeId } : {}),
    ...(typeof dedup.nativeCallId === 'string' ? { nativeCallId: dedup.nativeCallId } : {}),
    ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: {
      ...identityHints(record, envelope),
      ...extraIdentity,
    },
    dedupHints: {
      ...(record.nativeId ? { nativeEventId: record.nativeId } : {}),
      ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
      ...dedup,
    },
  }
}

function unknownCandidate(
  record: SourceRecord,
  envelope: CodexStoredEnvelope,
  rawPayload: JsonValue = envelope.entry as JsonValue,
): ObservationCandidate {
  return candidate(record, envelope, 'unknown', {
    rawType: record.nativeType,
    rawPayload,
  })
}

function injectedContextCandidate(
  record: SourceRecord,
  envelope: CodexStoredEnvelope,
  role: string,
  text: string,
): ObservationCandidate {
  const classification = contextClassification(role, text)
  return candidate(record, envelope, 'context.injected', {
    sourceType: record.nativeType,
    injectedContext: true,
    role,
    label: classification.label,
    injectedKind: classification.kind,
    text,
    provenance: classification.provenance,
  })
}

function runtimeSuccess(response: unknown): { success: boolean; exitCode?: number } {
  const value = asRecord(response)
  const rawExitCode = value.exit_code ?? value.exitCode
  const exitCode = typeof rawExitCode === 'number'
    ? rawExitCode
    : typeof rawExitCode === 'string' && /^-?\d+$/.test(rawExitCode)
      ? Number.parseInt(rawExitCode, 10)
      : undefined
  const success = value.success === false || (exitCode !== undefined && exitCode !== 0)
    ? false
    : true
  return {
    success,
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}

function responseItemCallId(
  payload: Record<string, unknown>,
  record: SourceRecord,
  prefix: string,
): string {
  return stringField(payload, 'call_id', 'id') ?? `${prefix}-${record.sourceSequence ?? record.id}`
}

function runtimeEnvelope(record: SourceRecord): {
  envelope: CodexStoredEnvelope
  event: Record<string, unknown>
} {
  const payload = asRecord(record.payload)
  const session = asRecord(payload.session)
  const event = asRecord(payload.runtimeEvent)
  const cwd = stringField(session, 'cwd')
  return {
    envelope: {
      entry: event,
      session: {
        nativeSessionId: stringField(session, 'nativeSessionId')
          ?? record.sourceSessionNativeId
          ?? 'runtime-unknown',
        ...(cwd ? { cwd } : {}),
      },
    },
    event,
  }
}

function normalizeRuntimeRecord(
  record: SourceRecord,
): ObservationCandidate {
  const { envelope, event } = runtimeEnvelope(record)
  const hookName = stringField(event, 'hook_event_name', 'event_name', 'type') ?? 'UnknownHookEvent'
  const callId = stringField(event, 'call_id', 'tool_use_id')
  const toolName = stringField(event, 'tool_name', 'name', 'tool') ?? 'unknown'
  const actorId = stringField(event, 'agent_id', 'subagent_id')
  const turnId = stringField(event, 'turn_id')
  const actorIdentity: Partial<ObservationIdentityHints> = actorId
    ? { nativeActorId: actorId, actorRole: 'subagent' }
    : {}

  if (hookName === 'PreToolUse') {
    const stableCallId = callId ?? `codex-runtime-call-${record.id}`
    return candidate(record, envelope, 'tool.call', {
      callId: stableCallId,
      nativeToolName: toolName,
      input: event.tool_input ?? event.input ?? {},
      ...(turnId ? { turnId } : {}),
    }, { nativeCallId: stableCallId }, actorIdentity)
  }

  if (hookName === 'PostToolUse') {
    const stableCallId = callId ?? `codex-runtime-call-${record.id}`
    const response = event.tool_response ?? event.output ?? event.result ?? null
    const outcome = runtimeSuccess(response)
    return candidate(record, envelope, 'tool.result', {
      callId: stableCallId,
      nativeToolName: toolName,
      success: outcome.success,
      ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
      ...(response == null ? {} : { output: response }),
      ...(typeof event.duration_ms === 'number' ? { durationMs: event.duration_ms } : {}),
    }, { nativeCallId: stableCallId }, actorIdentity)
  }

  if (hookName === 'SessionStart' || hookName === 'SessionEnd') {
    return candidate(record, envelope, 'session.lifecycle', {
      event: hookName === 'SessionStart' ? 'session.started' : 'session.ended',
      ...(stringField(event, 'source') ? { source: stringField(event, 'source') } : {}),
      ...(stringField(event, 'reason') ? { reason: stringField(event, 'reason') } : {}),
      ...(stringField(event, 'model') ? { model: stringField(event, 'model') } : {}),
    })
  }

  if (hookName === 'UserPromptSubmit') {
    return candidate(record, envelope, 'message.user', {
      text: stringField(event, 'prompt', 'user_prompt', 'message') ?? '',
      provenance: userMessageProvenance(),
      ...(turnId ? { turnId } : {}),
    })
  }

  if (hookName === 'PermissionRequest') {
    return candidate(record, envelope, 'permission.request', {
      nativeToolName: toolName,
      input: event.tool_input ?? {},
      ...(turnId ? { turnId } : {}),
    }, {}, actorIdentity)
  }

  if (hookName === 'PreCompact' || hookName === 'PostCompact') {
    return candidate(record, envelope, 'context.compaction', {
      phase: hookName === 'PreCompact' ? 'start' : 'end',
      ...(stringField(event, 'trigger') ? { trigger: stringField(event, 'trigger') } : {}),
      ...(turnId ? { turnId } : {}),
    })
  }

  if (hookName === 'SubagentStart' || hookName === 'SubagentStop') {
    return candidate(
      record,
      envelope,
      hookName === 'SubagentStart' ? 'subagent.spawn' : 'subagent.end',
      {
        ...(actorId ? { nativeActorId: actorId } : {}),
        ...(stringField(event, 'agent_type') ? { agentType: stringField(event, 'agent_type') } : {}),
        ...(turnId ? { turnId } : {}),
        ...(hookName === 'SubagentStop' && stringField(event, 'last_assistant_message')
          ? { lastAssistantMessage: stringField(event, 'last_assistant_message') }
          : {}),
      },
      {},
      actorIdentity,
    )
  }

  if (hookName === 'Stop') {
    return candidate(record, envelope, 'session.lifecycle', {
      event: 'turn.stopped',
      ...(turnId ? { turnId } : {}),
      ...(stringField(event, 'last_assistant_message')
        ? { lastAssistantMessage: stringField(event, 'last_assistant_message') }
        : {}),
    }, {}, actorIdentity)
  }

  return unknownCandidate(record, envelope, event as unknown as JsonValue)
}

export async function normalizeCodexRecord(
  record: SourceRecord,
  ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  if (record.locator.kind === 'runtime-hook') {
    return {
      observations: [normalizeRuntimeRecord(record)],
      evidenceCandidates: [evidenceFor(record)],
    }
  }

  const envelope = asRecord(record.payload) as unknown as CodexStoredEnvelope
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  const topType = typeof entry.type === 'string' ? entry.type : 'unknown'
  const innerType = typeof payload.type === 'string' ? payload.type : undefined
  const observations: ObservationCandidate[] = []
  const relationships: NonNullable<NormalizedSourceOutput['sessionRelationshipHints']> = []
  const push = (observation: ObservationCandidate) => { observations.push(observation) }

  if (topType === 'session_start') {
    push(candidate(record, envelope, 'session.lifecycle', {
      event: 'session.started',
      nativeSessionId: envelope.session.nativeSessionId,
      ...(stringField(payload, 'startedAt') ? { startedAt: stringField(payload, 'startedAt') } : {}),
    }))
  } else if (topType === 'session_title') {
    push(candidate(record, envelope, 'session.lifecycle', {
      event: 'session.title',
      ...(stringField(payload, 'title') ? { title: stringField(payload, 'title') } : {}),
      ...(stringField(payload, 'updatedAt') ? { updatedAt: stringField(payload, 'updatedAt') } : {}),
    }))
  } else if (topType === 'session_meta') {
    const parentId = parentThreadId(payload)
    const subagent = sourceSubagent(payload)
    const nativeActorId = stringField(payload, 'agent_path', 'agent_nickname')
      ?? stringField(subagent, 'id', 'agent_id', 'nickname')
    const role = actorRole(payload.agent_role ?? subagent.agent_role ?? subagent.role)
    const modelProvider = stringField(payload, 'model_provider')
    const activity = sessionActivity(payload)
    push(candidate(record, envelope, 'session.lifecycle', {
      event: 'session.discovered',
      ...payload,
      sessionActivity: activity.kind,
      ...(activity.sourceLabel ? { activitySourceLabel: activity.sourceLabel } : {}),
      sessionId: stringField(payload, 'session_id', 'id') ?? envelope.session.nativeSessionId,
      ...(parentId ? { parentSessionId: parentId } : {}),
    }, {}, {
      ...(parentId ? { nativeParentSessionId: parentId } : {}),
      ...(nativeActorId ? { nativeActorId, actorRole: role } : {}),
      ...(modelProvider ? { modelName: modelProvider } : {}),
    }))
    if (parentId) {
      relationships.push({
        sourceId: 'codex',
        installationId: record.installationId,
        ...(ctx.runtimeProfile?.id ? { runtimeProfileId: ctx.runtimeProfile.id } : {}),
        fromNativeSessionId: parentId,
        toNativeSessionId: envelope.session.nativeSessionId,
        type: activity.relationship,
        nativeRelation: stringField(payload, 'forked_from_id')
          ? 'forked_from_id'
          : stringField(payload, 'parent_thread_id')
            ? 'parent_thread_id'
            : 'parent_session_id',
        confidence: 'exact',
      })
    }
  } else if (topType === 'turn_context') {
    const cwd = stringField(payload, 'cwd')
    const model = stringField(payload, 'model')
    push(candidate(record, envelope, 'session.lifecycle', {
      event: 'turn.context',
      ...payload,
    }, {}, {
      ...(cwd ? { workspacePath: cwd } : {}),
      ...(model ? { modelName: model } : {}),
    }))
  } else if (topType === 'event_msg') {
    if (innerType === 'user_message') {
      const text = stringField(payload, 'message', 'text', 'prompt') ?? messageText(payload.content)
      const attachments = attachmentMetadata(payload)
      push(candidate(record, envelope, 'message.user', {
        text,
        provenance: userMessageProvenance(),
        ...(stringField(payload, 'kind') ? { messageKind: stringField(payload, 'kind') } : {}),
        ...(attachments.length ? { attachments } : {}),
      }))
    } else if (innerType === 'token_count') {
      push(candidate(record, envelope, 'usage', tokenUsage(payload)))
    } else if (innerType && visibleReasoningTypes.has(innerType)) {
      const text = visibleReasoningText(payload)
      push(candidate(record, envelope, 'message.reasoning', {
        ...(text ? { text } : {}),
        raw: payload,
      }))
    } else if (innerType === 'task_started' || innerType === 'turn_started') {
      push(candidate(record, envelope, 'session.lifecycle', { event: 'turn.started', ...payload }))
    } else if (innerType === 'task_complete' || innerType === 'turn_complete') {
      push(candidate(record, envelope, 'session.lifecycle', { event: 'turn.completed', ...payload }))
    } else if (innerType === 'turn_aborted') {
      push(candidate(record, envelope, 'session.lifecycle', { event: 'turn.aborted', ...payload }))
    } else if (innerType === 'context_compacted') {
      push(candidate(record, envelope, 'context.compaction', { phase: 'end', ...payload }))
    } else if (innerType === 'error') {
      push(candidate(record, envelope, 'session.lifecycle', { event: 'turn.error', ...payload }))
    } else {
      push(unknownCandidate(record, envelope, entry as JsonValue))
    }
  } else if (topType === 'compacted') {
    push(candidate(record, envelope, 'context.compaction', { phase: 'end', ...payload }))
  } else if (topType === 'token_usage_record') {
    push(candidate(record, envelope, 'usage', tokenUsage(payload)))
  } else if (topType === 'response_item' && innerType === 'message') {
    const role = typeof payload.role === 'string' ? payload.role : 'unknown'
    const phase = typeof payload.phase === 'string' ? payload.phase : undefined
    const text = messageText(payload.content ?? payload.text ?? '')
    if (role !== 'assistant') {
      push(injectedContextCandidate(record, envelope, role, text))
    } else {
      const kind = phase === 'commentary' ? 'message.commentary' : 'message.assistant'
      const visible = splitCodexVisibleAssistantText(text, phase)
      push(candidate(record, envelope, kind, {
        text: visible.text,
        provenance: assistantMessageProvenance(role),
        ...(phase ? { phase } : {}),
        ...(visible.sourceMetadata ? { sourceMetadata: visible.sourceMetadata } : {}),
        ...(visible.sourceMetadata || payload.content === undefined ? {} : { content: payload.content }),
      }))
    }
  } else if (topType === 'response_item' && innerType === 'agent_message') {
    const author = stringField(payload, 'author') ?? 'unknown'
    const recipient = stringField(payload, 'recipient') ?? 'unknown'
    const text = messageText(payload.content)
    push(candidate(record, envelope, 'subagent.communication', {
      sourceType: 'response_item.agent_message',
      author,
      recipient,
      ...(text ? { text } : {}),
      ...(payload.content === undefined ? {} : { content: payload.content }),
      raw: payload,
    }))
  } else if (topType === 'response_item' && (innerType === 'function_call' || innerType === 'custom_tool_call')) {
    const callId = responseItemCallId(payload, record, 'codex-call')
    const name = stringField(payload, 'name') ?? innerType
    const rawInput = innerType === 'custom_tool_call' ? payload.input : payload.arguments
    let input: unknown = rawInput ?? null
    if (typeof rawInput === 'string') {
      try { input = JSON.parse(rawInput) } catch { input = rawInput }
    }
    push(candidate(record, envelope, 'tool.call', { callId, nativeToolName: name, input }, { nativeCallId: callId }))
  } else if (topType === 'response_item' && innerType === 'local_shell_call') {
    const callId = responseItemCallId(payload, record, 'local-shell')
    push(candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: 'local_shell',
      input: {
        action: payload.action ?? null,
        status: payload.status ?? null,
      },
      raw: payload,
    }, { nativeCallId: callId }))
  } else if (topType === 'response_item' && innerType === 'tool_search_call') {
    const callId = responseItemCallId(payload, record, 'tool-search')
    push(candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: 'tool_search',
      input: {
        execution: payload.execution ?? null,
        arguments: payload.arguments ?? null,
        ...(payload.status === undefined ? {} : { status: payload.status }),
      },
      raw: payload,
    }, { nativeCallId: callId }))
  } else if (topType === 'response_item' && (innerType === 'function_call_output' || innerType === 'custom_tool_call_output' || innerType === 'tool_search_output')) {
    const callId = responseItemCallId(payload, record, 'codex-call')
    const outputValue = innerType === 'tool_search_output'
      ? payload.tools ?? payload.output ?? payload.result ?? payload.content
      : payload.output ?? payload.result ?? payload.content
    const result = parseFunctionOutput(messageText(outputValue))
    push(candidate(record, envelope, 'tool.result', {
      callId,
      ...(innerType === 'tool_search_output' ? { nativeToolName: 'tool_search' } : {}),
      success: result.success,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.output ? { output: result.output } : outputValue === undefined ? {} : { output: outputValue }),
      ...(innerType === 'tool_search_output' ? { raw: payload } : {}),
    }, { nativeCallId: callId }))
  } else if (topType === 'response_item' && innerType === 'web_search_call') {
    const callId = responseItemCallId(payload, record, 'web-search')
    push(candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: 'web_search',
      input: {
        action: payload.action ?? null,
        ...(payload.status === undefined ? {} : { status: payload.status }),
      },
      raw: payload,
    }, { nativeCallId: callId }))
  } else if (topType === 'response_item' && innerType === 'image_generation_call') {
    push(candidate(record, envelope, 'artifact.action', {
      action: 'image.generated',
      status: payload.status ?? 'unknown',
      ...(stringField(payload, 'id') ? { nativeArtifactId: stringField(payload, 'id') } : {}),
      ...(stringField(payload, 'revised_prompt') ? { revisedPrompt: stringField(payload, 'revised_prompt') } : {}),
      ...(payload.result === undefined ? {} : { result: payload.result }),
      raw: payload,
    }))
  } else if (topType === 'response_item' && innerType === 'reasoning') {
    const text = messageText(payload.summary ?? payload.content ?? payload.text ?? '')
    push(candidate(record, envelope, 'message.reasoning', {
      ...(text ? { text } : {}),
      raw: payload,
    }))
  } else if (topType === 'response_item' && innerType === 'configuration_update') {
    push(candidate(record, envelope, 'reasoning.configuration.updated', {
      reasoning: payload.reasoning ?? null,
      raw: payload,
    }))
  } else if (topType === 'response_item' && (innerType === 'compaction' || innerType === 'context_compaction')) {
    push(candidate(record, envelope, 'context.compaction', {
      phase: 'end',
      sourceType: `response_item.${innerType}`,
      raw: payload,
    }))
  } else if (topType === 'inter_agent_communication') {
    push(candidate(record, envelope, 'subagent.communication', {
      sourceType: 'inter_agent_communication',
      ...payload,
      raw: payload,
    }))
  } else if (topType === 'world_state' || topType === 'realtime_item' || topType === 'security_risk_score') {
    push(unknownCandidate(record, envelope, entry as JsonValue))
  } else {
    push(unknownCandidate(record, envelope, entry as JsonValue))
  }

  return {
    observations,
    evidenceCandidates: [evidenceFor(record)],
    ...(relationships.length ? { sessionRelationshipHints: relationships } : {}),
  }
}
