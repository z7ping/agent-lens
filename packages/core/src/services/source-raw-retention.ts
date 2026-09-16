import type {
  SourceRawRecoveryCapability,
  SourceRawRecoveryCheck,
} from '../contracts/source'

export interface SourceRawRetentionFacts {
  capability?: SourceRawRecoveryCapability
  verification?: SourceRawRecoveryCheck
  canonicalStable: boolean
  evidenceStable: boolean
  pinned: boolean | 'unknown'
}

export type SourceRawRetentionReason =
  | 'pinned'
  | 'pin-state-unknown'
  | 'canonical-not-stable'
  | 'evidence-not-stable'
  | 'recovery-capability-unknown'
  | 'native-source-not-authoritative'
  | 'source-not-rereadable'
  | 'locator-not-stable'
  | 'source-not-replayable'
  | 'fingerprint-required'
  | 'source-unavailable'
  | 'source-drifted'
  | 'verification-unsupported'
  | 'verification-unknown'

export interface SourceRawRetentionDecision {
  autoReclaimEligible: boolean
  reasons: SourceRawRetentionReason[]
}

export function evaluateSourceRawRetention(
  facts: SourceRawRetentionFacts,
): SourceRawRetentionDecision {
  const reasons: SourceRawRetentionReason[] = []

  if (facts.pinned === true) reasons.push('pinned')
  else if (facts.pinned === 'unknown') reasons.push('pin-state-unknown')
  if (!facts.canonicalStable) reasons.push('canonical-not-stable')
  if (!facts.evidenceStable) reasons.push('evidence-not-stable')

  const capability = facts.capability
  if (!capability) {
    reasons.push('recovery-capability-unknown')
    return { autoReclaimEligible: false, reasons }
  }

  if (capability.authority !== 'native-store') {
    reasons.push('native-source-not-authoritative')
  }
  if (!capability.canReread) reasons.push('source-not-rereadable')
  if (capability.locatorStability !== 'stable') reasons.push('locator-not-stable')
  if (!capability.replayable || !capability.canReparse) reasons.push('source-not-replayable')

  if (capability.verification === 'fingerprint') {
    const verification = facts.verification
    if (!verification) {
      reasons.push('fingerprint-required')
    } else if (verification.state === 'unavailable') {
      reasons.push('source-unavailable')
    } else if (verification.state === 'drifted') {
      reasons.push('source-drifted')
    } else if (verification.state === 'unsupported') {
      reasons.push('verification-unsupported')
    } else if (verification.state !== 'verified') {
      reasons.push('verification-unknown')
    }
  } else {
    // Phase 2 only allows automatic Raw reclaim when current native content can
    // be verified against the captured SourceRecord. Identity-only is not enough.
    reasons.push('fingerprint-required')
  }

  return {
    autoReclaimEligible: reasons.length === 0,
    reasons,
  }
}
