import {
  evidenceFromSourceRecord,
  observationFromSourceRecord,
  type NormalizedSourceOutput,
  type ObservationCandidate,
  type ObservationIdentityHints,
  type SourceNormalizationContext,
  type SourceRecord,
} from '@agent-lens/core'
import { normalizePiSessionEntry, type PiNativeFact } from '@agent-lens/protocol'

interface PiStoredEnvelope {
  entry: Record<string, unknown>
  session: {
    nativeSessionId: string
    cwd?: string
    nativeParentSessionId?: string
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

function normalizedMessageAttachments(values: readonly unknown[]): {
  attachments: Record<string, unknown>[]
  remainder: unknown[]
} {
  const attachments: Record<string, unknown>[] = []
  const remainder: unknown[] = []

  for (const value of values) {
    const block = asRecord(value)
    const type = stringField(block, 'type')
    const mimeType = stringField(block, 'mimeType', 'mime_type', 'mediaType', 'media_type')?.toLowerCase()
    const data = stringField(block, 'data', 'base64')
    if (type === 'image' && mimeType?.startsWith('image/') && data) {
      attachments.push({
        type: 'image',
        mimeType,
        data,
        ...(stringField(block, 'name', 'fileName', 'file_name', 'filename')
          ? { name: stringField(block, 'name', 'fileName', 'file_name', 'filename')! }
          : {}),
      })
      continue
    }
    remainder.push(value)
  }

  return { attachments, remainder }
}

function entryNativeId(envelope: PiStoredEnvelope): string | undefined {
  return stringField(envelope.entry, 'id')
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

  return observationFromSourceRecord(record, {
    kind,
    payload,
    identityHints: { ...baseIdentity(record, envelope), ...(options.identity ?? {}) },
    ...(nativeEventId ? { nativeEventId } : {}),
    ...(nativeParentEventId ? { nativeParentEventId } : {}),
    ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
    ...(sharedEventKey ? { sharedEventKey } : {}),
    sequenceOffset,
  })
}

function injectedContextPayload(fact: Extract<PiNativeFact, { kind: 'event' }>): Record<string, unknown> {
  return {
    event: fact.event,
    text: fact.detail,
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
  const facts = normalizePiSessionEntry(entry, { fallbackId: record.id })
  const observations: ObservationCandidate[] = []

  facts.forEach((fact, index) => {
    const offset = index + 1

    if (fact.kind === 'message') {
      if (fact.role === 'user') {
        const normalized = normalizedMessageAttachments(fact.nonTextContent)
        observations.push(piFactCandidate(record, envelope, fact, 'message.user', {
          text: fact.text,
          ...(normalized.attachments.length ? { attachments: normalized.attachments } : {}),
          ...(normalized.remainder.length ? { nonTextContent: normalized.remainder } : {}),
        }, offset))
        return
      }

      if (fact.role === 'assistant') {
        const normalized = normalizedMessageAttachments(fact.nonTextContent)
        observations.push(piFactCandidate(record, envelope, fact, 'message.assistant', {
          text: fact.text,
          ...(fact.content === undefined ? {} : { content: fact.content }),
          ...(normalized.attachments.length ? { attachments: normalized.attachments } : {}),
          ...(normalized.remainder.length ? { nonTextContent: normalized.remainder } : {}),
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
      observations.push(piFactCandidate(record, envelope, fact, 'message.reasoning', { text: fact.text }, offset))
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
        output: fact.output,
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

  const nativeStableId = entryNativeId(envelope)
  return {
    observations,
    evidenceCandidates: [evidenceFromSourceRecord(record, {
      captureMethod: 'native-log',
      derivation: 'reported',
      ...(nativeStableId ? { nativeStableId } : {}),
      confidenceHint: nativeStableId ? 'exact' : 'high',
    })],
  }
}
