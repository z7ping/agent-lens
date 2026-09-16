import type {
  SourceDefinition,
  SourceRawRecoveryCapability,
  SourceRawRecoveryCheck,
} from '../contracts/source'
import type {
  SourceRawAuditCandidate,
  SourceRawAuditReader,
  SourceRawRetentionDecision,
} from './source-raw-retention'
import { evaluateSourceRawRetention } from './source-raw-retention'

export interface SourceRawRecoveryAuditItem {
  recordId: string
  sourceId: string
  installationId: string
  capability?: SourceRawRecoveryCapability
  recovery: SourceRawRecoveryCheck
  canonicalStable: boolean
  evidenceStable: boolean
  pinned: boolean | 'unknown'
  decision: SourceRawRetentionDecision
}

export interface SourceRawRecoveryAuditBatch {
  items: SourceRawRecoveryAuditItem[]
  cursor?: string
  hasMore: boolean
  summary: {
    scanned: number
    eligible: number
    preserved: number
    unavailable: number
    drifted: number
    unknown: number
  }
}

function initialRecoveryCheck(
  capability: SourceRawRecoveryCapability | undefined,
  hasVerifier: boolean,
): SourceRawRecoveryCheck {
  const checkedAt = new Date().toISOString()
  if (!capability) {
    return {
      state: 'unknown',
      checkedAt,
      reason: 'source-does-not-declare-raw-recovery-policy',
    }
  }
  if (
    capability.persistencePreference === 'preserve'
    || !capability.canReread
    || !capability.replayable
  ) {
    return {
      state: 'preserved',
      checkedAt,
      reason: capability.reason ?? 'source-raw-must-be-preserved',
    }
  }
  return hasVerifier
    ? {
        state: 'unknown',
        checkedAt,
        reason: 'verification-not-run',
      }
    : {
        state: 'unsupported',
        checkedAt,
        reason: 'source-recovery-verifier-unavailable',
      }
}

export async function auditSourceRawRecoveryBatch(input: {
  sources: { list(): SourceDefinition[] }
  storage: { sourceRawAudit?: SourceRawAuditReader }
  cursor?: string
  limit?: number
  signal?: AbortSignal
}): Promise<SourceRawRecoveryAuditBatch> {
  const reader = input.storage.sourceRawAudit
  if (!reader) {
    return {
      items: [],
      hasMore: false,
      summary: {
        scanned: 0,
        eligible: 0,
        preserved: 0,
        unavailable: 0,
        drifted: 0,
        unknown: 0,
      },
    }
  }

  const definitions = new Map(
    input.sources.list().map(definition => [definition.manifest.sourceId, definition]),
  )
  const page = await reader.list(input.cursor, input.limit)
  const items: SourceRawRecoveryAuditItem[] = []

  for (const candidate of page.items) {
    if (input.signal?.aborted) break
    const definition = definitions.get(candidate.record.sourceId)
    const policy = definition?.rawRecovery
    const capability = policy?.describe(candidate.record)
    let recovery = initialRecoveryCheck(capability, Boolean(policy?.verify))
    let decision = evaluateSourceRawRetention({
      ...(capability ? { capability } : {}),
      verification: recovery,
      canonicalStable: candidate.canonicalStable,
      evidenceStable: candidate.evidenceStable,
      pinned: candidate.pinned,
    })

    const verificationIsOnlyBlocker = decision.reasons.length === 1
      && decision.reasons[0] === 'verification-unknown'
    if (verificationIsOnlyBlocker && policy?.verify) {
      try {
        recovery = await policy.verify(candidate.record)
      } catch (error) {
        recovery = {
          state: 'unavailable',
          checkedAt: new Date().toISOString(),
          reason: error instanceof Error ? error.message : String(error),
        }
      }
      decision = evaluateSourceRawRetention({
        ...(capability ? { capability } : {}),
        verification: recovery,
        canonicalStable: candidate.canonicalStable,
        evidenceStable: candidate.evidenceStable,
        pinned: candidate.pinned,
      })
    }
    items.push({
      recordId: candidate.record.id,
      sourceId: candidate.record.sourceId,
      installationId: candidate.record.installationId,
      ...(capability ? { capability } : {}),
      recovery,
      canonicalStable: candidate.canonicalStable,
      evidenceStable: candidate.evidenceStable,
      pinned: candidate.pinned,
      decision,
    })
  }

  const stateCount = (state: SourceRawRecoveryCheck['state']) =>
    items.filter(item => item.recovery.state === state).length

  return {
    items,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    hasMore: page.hasMore && !input.signal?.aborted,
    summary: {
      scanned: items.length,
      eligible: items.filter(item => item.decision.autoReclaimEligible).length,
      preserved: stateCount('preserved'),
      unavailable: stateCount('unavailable'),
      drifted: stateCount('drifted'),
      unknown: stateCount('unknown') + stateCount('unsupported'),
    },
  }
}
