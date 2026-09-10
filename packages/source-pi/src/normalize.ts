import type {
  EvidenceCandidate,
  NormalizedSourceOutput,
  ObservationCandidate,
  ObservationIdentityHints,
  SourceNormalizationContext,
  SourceRecord,
} from '@agent-lens/core'
import { normalizePiSessionEntry, type PiNativeFact } from '@agent-lens/protocol'

const MAX_STRING = 64 * 1024

interface PiStoredEnvelope {
  entry: Record<string, unknown>
  session: {
    nativeSessionId: string
    cwd?: string
    nativeParentSessionId?: string
  }
}

function truncate(value: string, limit = MAX_STRING): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…[truncated]`
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

function entryNativeId(envelope: PiStoredEnvelope): string | undefined {
  return stringField(envelope.entry, 'id')
}

function evidenceFor(record: SourceRecord, envelope: PiStoredEnvelope): EvidenceCandidate {
  const nativeStableId = entryNativeId(envelope)
  return {
    captureMethod: 'native-log',
    derivation: 'reported',
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(nativeStableId ? { nativeStableId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    confidenceHint: nativeStableId ? 'exact' : 'high',
  }
}

function baseIdentity(
  record: SourceRecord,
  envelope: PiStoredEnvelope,
): ObservationIdentityHints {
  return {
    nativeSessionId: envelope.session.nativeSessionId || record.sourceSessionNativeId || 'unknown',
    ...(envelope.session.nativeParentSessionId
      ? { nativeParentSessionId: envelope.session.nativeParentSessionId }
      : {}),
    ...(envelope.session.cwd ? { workspacePath: envelope.session.cwd } : {}),
  }
}

function candidate(
  record: SourceRecord,
  envelope: PiStoredEnvelope,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  options: {
    nativeCallId?: string
    nativeEventId?: string
    nativeParentEventId?: string
    sharedEventKey?: string
    sequenceOffset?: number
    identity?: Partial<ObservationIdentityHints>
  } = {},
): ObservationCandidate {
  const nativeCallId = options.nativeCallId
  const eventId = options.nativeEventId
  const sourceSequence = record.sourceSequence === undefined
    ? undefined
    : record.sourceSequence + (options.sequenceOffset ?? 0)
  const nativeParentEventId = options.nativeParentEventId ?? stringField(envelope.entry, 'parentId')
  return {
    kind,
    ...(eventId ? { nativeEventId: eventId } : {}),
    ...(nativeParentEventId ? { nativeParentEventId } : {}),
    ...(nativeCallId ? { nativeCallId } : {}),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload,
    identityHints: { ...baseIdentity(record, envelope), ...(options.identity ?? {}) },
    dedupHints: {
      ...(eventId ? { nativeEventId: eventId } : {}),
      ...(nativeCallId ? { nativeCallId } : {}),
      ...(options.sharedEventKey ? { sharedEventKey: options.sharedEventKey } : {}),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
    },
  }
}

function piFactCandidate(
  record: SourceRecord,
  envelope: PiStoredEnvelope,
  fact: PiNativeFact,
  kind: ObservationCandidate['kind'],
  payload: unknown,
  sequenceOffset: number,
  options: { nativeCallId?: string; identity?: Partial<ObservationIdentityHints> } = {},
): ObservationCandidate {
  const nativeEntryId = entryNativeId(envelope)
  const nativeEntryParentId = stringField(envelope.entry, 'parentId')
  const nativeEventId = nativeEntryId && fact.id === nativeEntryId
    ? nativeEntryId
    : undefined
  const nativeParentEventId = nativeEventId
    ? nativeEntryParentId
    : nativeEntryId && fact.parentId === nativeEntryId
      ? nativeEntryId
      : nativeEntryParentId && fact.parentId === nativeEntryParentId
        ? nativeEntryParentId
        : undefined
  const sharedEventKey = nativeEventId || options.nativeCallId
    ? undefined
    : fact.id

  return candidate(record, envelope, kind, payload, {
    ...(nativeEventId ? { nativeEventId } : {}),
    ...(nativeParentEventId ? { nativeParentEventId } : {}),
    ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
    ...(sharedEventKey ? { sharedEventKey } : {}),
    sequenceOffset,
    ...(options.identity ? { identity: options.identity } : {}),
  })
}

function injectedContextPayload(fact: Extract<PiNativeFact, { kind: 'event' }>): Record<string, unknown> {
  return {
    event: fact.event,
    text: truncate(fact.detail),
    rawPayload: fact.payload,
    provenance: {
      contentRole: 'application-context',
      actualAuthor: 'application',
      activityType: 'system-injection',
      originType: 'application-injection',
      sourceSignal: 'pi custom message',
      injectedKind: stringField(asRecord(fact.payload), 'customType') ?? 'custom',
    },
  }
}

export async function normalizePiRecord(
  record: SourceRecord,
  _ctx: SourceNormalizationContext,
): Promise<NormalizedSourceOutput> {
  const envelope = asRecord(record.payload) as unknown as PiStoredEnvelope
  const entry = asRecord(envelope.entry)
  const facts = normalizePiSessionEntry(entry, {
    fallbackId: record.id,
  })
  const observations: ObservationCandidate[] = []

  facts.forEach((fact, index) => {
    const offset = index + 1
    if (fact.kind === 'message') {
      if (fact.role === 'user') {
        observations.push(piFactCandidate(record, envelope, fact, 'message.user', {
          text: truncate(fact.text),
          ...(fact.nonTextContent.length ? { nonTextContent: fact.nonTextContent } : {}),
        }, offset))
        return
      }
      if (fact.role === 'assistant') {
        observations.push(piFactCandidate(record, envelope, fact, 'message.assistant', {
          text: truncate(fact.text),
          ...(fact.content === undefined ? {} : { content: fact.content }),
          ...(fact.nonTextContent.length ? { nonTextContent: fact.nonTextContent } : {}),
          ...(fact.model ? { model: fact.model } : {}),
          ...(fact.provider ? { provider: fact.provider } : {}),
          ...(fact.stopReason ? { stopReason: fact.stopReason } : {}),
          ...(fact.errorMessage ? { errorMessage: fact.errorMessage } : {}),
        }, offset, { identity: fact.model ? { modelName: fact.model } : {} }))
        return
      }
      observations.push(piFactCandidate(record, envelope, fact, 'unknown', {
        rawType: `message/${fact.role}`,
        rawPayload: fact.raw,
      }, offset))
      return
    }
    if (fact.kind === 'thinking') {
      observations.push(piFactCandidate(record, envelope, fact, 'message.reasoning', { text: truncate(fact.text) }, offset))
      return
    }
    if (fact.kind === 'tool-call') {
      observations.push(piFactCandidate(record, envelope, fact, 'tool.call', {
        ...(fact.callId ? { callId: fact.callId } : {}),
        nativeToolName: fact.name,
        input: fact.input,
      }, offset, { ...(fact.callId ? { nativeCallId: fact.callId } : {}) }))
      return
    }
    if (fact.kind === 'tool-result') {
      observations.push(piFactCandidate(record, envelope, fact, 'tool.result', {
        ...(fact.callId ? { callId: fact.callId } : {}),
        nativeToolName: fact.name,
        success: fact.success,
        output: truncate(fact.output),
        ...(fact.details === undefined ? {} : { details: fact.details }),
      }, offset, { ...(fact.callId ? { nativeCallId: fact.callId } : {}) }))
      return
    }
    if (fact.kind === 'usage') {
      observations.push(piFactCandidate(record, envelope, fact, 'usage', fact.usage, offset))
      return
    }
    if (fact.kind === 'event') {
      const kind: ObservationCandidate['kind'] = fact.event === 'model.changed'
        ? 'model.changed'
        : fact.event === 'thinking.level.changed'
          ? 'thinking.level.changed'
          : fact.event === 'context.compaction'
            ? 'context.compaction'
            : fact.event === 'context.summary'
              ? 'context.summary'
              : fact.event === 'pi.custom_message'
                ? 'context.injected'
                : fact.event === 'session.started' || fact.event === 'session.info'
                  ? 'session.lifecycle'
                  : 'unknown'
      const name = fact.event === 'session.info' ? stringField(asRecord(fact.payload), 'name')?.trim() : undefined
      const payload = kind === 'unknown'
        ? { event: fact.event, label: fact.label, detail: fact.detail, rawPayload: fact.payload }
        : kind === 'session.lifecycle'
          ? { event: fact.event, ...asRecord(fact.payload) }
          : kind === 'context.injected'
            ? injectedContextPayload(fact)
            : fact.payload
      observations.push(piFactCandidate(
        record,
        envelope,
        fact,
        kind,
        payload,
        offset,
        { ...(name ? { identity: { sessionTitle: name } } : {}) },
      ))
      return
    }
    observations.push(piFactCandidate(record, envelope, fact, 'unknown', {
      rawType: fact.nativeType,
      rawPayload: fact.payload,
    }, offset))
  })

  return { observations, evidenceCandidates: [evidenceFor(record, envelope)] }
}
