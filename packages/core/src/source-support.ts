import type { ObservationIdentityHints } from './domain/identity'
import type {
  EvidenceCandidate,
  ObservationCandidate,
  ObservationKind,
  SourceRecord,
} from './domain/observation'
import type {
  CaptureMethod,
  Confidence,
  Derivation,
} from './domain/common'

export interface SourceRecordEvidenceOptions {
  captureMethod: CaptureMethod
  derivation: Derivation
  nativeStableId?: string
  confidenceHint?: Confidence
}

export function evidenceFromSourceRecord(
  record: SourceRecord,
  options: SourceRecordEvidenceOptions,
): EvidenceCandidate {
  return {
    captureMethod: options.captureMethod,
    derivation: options.derivation,
    sourceRecordId: record.id,
    sourceLocator: record.locator,
    parserVersion: record.parserVersion,
    ...(options.nativeStableId ? { nativeStableId: options.nativeStableId } : {}),
    ...(record.occurredAt ? { eventTime: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    ...(options.confidenceHint ? { confidenceHint: options.confidenceHint } : {}),
  }
}

export interface SourceObservationOptions {
  kind: ObservationKind
  payload: unknown
  identityHints: ObservationIdentityHints
  nativeEventId?: string
  nativeParentEventId?: string
  nativeCallId?: string
  sharedEventKey?: string
  sequenceOffset?: number
}

export function observationFromSourceRecord(
  record: SourceRecord,
  options: SourceObservationOptions,
): ObservationCandidate {
  const sourceSequence = record.sourceSequence === undefined
    ? undefined
    : record.sourceSequence + (options.sequenceOffset ?? 0)

  return {
    kind: options.kind,
    ...(options.nativeEventId ? { nativeEventId: options.nativeEventId } : {}),
    ...(options.nativeParentEventId ? { nativeParentEventId: options.nativeParentEventId } : {}),
    ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
    ...(sourceSequence === undefined ? {} : { sourceSequence }),
    ...(record.occurredAt ? { occurredAt: record.occurredAt } : {}),
    capturedAt: record.capturedAt,
    payload: options.payload,
    identityHints: options.identityHints,
    dedupHints: {
      ...(options.nativeEventId ? { nativeEventId: options.nativeEventId } : {}),
      ...(options.nativeCallId ? { nativeCallId: options.nativeCallId } : {}),
      ...(options.sharedEventKey ? { sharedEventKey: options.sharedEventKey } : {}),
      ...(sourceSequence === undefined ? {} : { sourceSequence }),
      ...(record.fingerprint ? { payloadFingerprint: record.fingerprint } : {}),
    },
  }
}
