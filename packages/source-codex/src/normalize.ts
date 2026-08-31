import type {
  EvidenceCandidate,
  JsonValue,
  NormalizedSourceOutput,
  ObservationCandidate,
  ObservationIdentityHints,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import {
  messageText,
  parseFunctionOutput,
  sanitizeCodexEntry,
  type CodexStoredEnvelope,
} from './format'

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
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  if (record.locator.kind === 'runtime-hook') {
    return {
      observations: [normalizeRuntimeRecord(record)],
      evidenceCandidates: [evidenceFor(record)],
    }
  }

  const envelope = asRecord(record.payload) as unknown as CodexStoredEnvelope
  const entry = sanitizeCodexEntry(envelope.entry)
  const payload = asRecord(entry.payload)
  const topType = typeof entry.type === 'string' ? entry.type : 'unknown'
  const innerType = typeof payload.type === 'string' ? payload.type : undefined
  let observation: ObservationCandidate

  if (topType === 'session_start') {
    observation = candidate(record, envelope, 'session.lifecycle', {
      event: 'session.started',
      nativeSessionId: envelope.session.nativeSessionId,
      ...(stringField(payload, 'startedAt') ? { startedAt: stringField(payload, 'startedAt') } : {}),
    })
  } else if (topType === 'session_title') {
    observation = candidate(record, envelope, 'session.lifecycle', {
      event: 'session.title',
      ...(stringField(payload, 'title') ? { title: stringField(payload, 'title') } : {}),
      ...(stringField(payload, 'updatedAt') ? { updatedAt: stringField(payload, 'updatedAt') } : {}),
    })
  } else if (topType === 'session_meta') {
    observation = candidate(record, envelope, 'session.lifecycle', {
      event: 'session.discovered',
      nativeSessionId: envelope.session.nativeSessionId,
      ...(envelope.session.cwd ? { cwd: envelope.session.cwd } : {}),
      ...(envelope.session.cliVersion ? { cliVersion: envelope.session.cliVersion } : {}),
    })
  } else if (topType === 'response_item' && innerType === 'message') {
    const role = typeof payload.role === 'string' ? payload.role : 'unknown'
    const text = typeof payload.text === 'string' ? payload.text : ''
    const injected = payload.injectedContext === true
    if (injected || (role !== 'user' && role !== 'assistant')) {
      observation = unknownCandidate(record, envelope)
    } else {
      observation = candidate(
        record,
        envelope,
        role === 'user' ? 'message.user' : 'message.assistant',
        { text },
      )
    }
  } else if (topType === 'response_item' && innerType === 'function_call') {
    const callId = typeof payload.call_id === 'string'
      ? payload.call_id
      : `codex-call-${record.sourceSequence ?? record.id}`
    const name = typeof payload.name === 'string' ? payload.name : 'unknown'
    let input: unknown = payload.arguments ?? null
    if (typeof payload.arguments === 'string') {
      try {
        input = JSON.parse(payload.arguments)
      } catch {
        input = payload.arguments
      }
    }
    observation = candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: name,
      input,
    }, { nativeCallId: callId })
  } else if (topType === 'response_item' && innerType === 'function_call_output') {
    const callId = typeof payload.call_id === 'string'
      ? payload.call_id
      : `codex-call-${record.sourceSequence ?? record.id}`
    const result = parseFunctionOutput(payload.output)
    observation = candidate(record, envelope, 'tool.result', {
      callId,
      success: result.success,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.output ? { output: result.output } : {}),
    }, { nativeCallId: callId })
  } else if (topType === 'response_item' && innerType === 'custom_tool_call') {
    const callId = typeof payload.call_id === 'string'
      ? payload.call_id
      : `codex-custom-call-${record.sourceSequence ?? record.id}`
    const name = typeof payload.name === 'string' ? payload.name : 'unknown'
    let input: unknown = payload.input ?? null
    if (typeof payload.input === 'string') {
      try {
        input = JSON.parse(payload.input)
      } catch {
        input = payload.input
      }
    }
    observation = candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: name,
      input,
    }, { nativeCallId: callId })
  } else if (topType === 'response_item' && innerType === 'custom_tool_call_output') {
    const callId = typeof payload.call_id === 'string'
      ? payload.call_id
      : `codex-custom-call-${record.sourceSequence ?? record.id}`
    const result = parseFunctionOutput(messageText(payload.output))
    observation = candidate(record, envelope, 'tool.result', {
      callId,
      success: result.success,
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.output ? { output: result.output } : {}),
    }, { nativeCallId: callId })
  } else if (topType === 'response_item' && innerType === 'web_search_call') {
    const action = asRecord(payload.action)
    const callId = typeof payload.call_id === 'string'
      ? payload.call_id
      : `web-search-${record.sourceSequence ?? record.id}`
    observation = candidate(record, envelope, 'tool.call', {
      callId,
      nativeToolName: 'web_search',
      input: {
        ...(typeof action.query === 'string' ? { query: action.query } : {}),
      },
    }, { nativeCallId: callId })
  } else if (topType === 'response_item' && innerType === 'reasoning' && typeof payload.text === 'string' && payload.text) {
    observation = candidate(record, envelope, 'message.reasoning', {
      text: payload.text,
    })
  } else {
    observation = unknownCandidate(record, envelope)
  }

  return {
    observations: [observation],
    evidenceCandidates: [evidenceFor(record)],
  }
}
