import type {
  EvidenceCandidate,
  JsonValue,
  NormalizedSourceOutput,
  ObservationCandidate,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import {
  parseFunctionOutput,
  type CodexStoredEnvelope,
} from './format'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function evidenceFor(record: SourceRecord): EvidenceCandidate {
  return {
    captureMethod: 'native-log',
    derivation: 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(record.nativeId ? { nativeStableId: record.nativeId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: record.nativeId ? 'exact' : 'high',
  }
}

function identityHints(record: SourceRecord, envelope: CodexStoredEnvelope) {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: CodexStoredEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  dedup: Partial<NonNullable<ObservationCandidate['dedupHints']>> = {},
): ObservationCandidate {
  return {
    kind,
    ...(record.nativeId ? { nativeEventId: record.nativeId } : {}),
    ...(typeof dedup.nativeCallId === 'string' ? { nativeCallId: dedup.nativeCallId } : {}),
    ...(record.sourceSequence === undefined ? {} : { sourceSequence: record.sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: identityHints(record, envelope),
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
): ObservationCandidate {
  return candidate(record, envelope, 'unknown', {
    rawType: record.nativeType,
    rawPayload: envelope.entry as JsonValue,
  })
}

export async function normalizeCodexRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const envelope = asRecord(record.payload) as unknown as CodexStoredEnvelope
  const entry = asRecord(envelope.entry)
  const payload = asRecord(entry.payload)
  const topType = typeof entry.type === 'string' ? entry.type : 'unknown'
  const innerType = typeof payload.type === 'string' ? payload.type : undefined
  let observation: ObservationCandidate

  if (topType === 'session_meta') {
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
