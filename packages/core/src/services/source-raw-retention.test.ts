import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  SourceRawRecoveryCapability,
  SourceRawRecoveryCheck,
} from '../contracts/source'
import { evaluateSourceRawRetention } from './source-raw-retention'

const recoverable: SourceRawRecoveryCapability = {
  authority: 'native-store',
  locatorStability: 'stable',
  mutability: 'append-oriented',
  verification: 'fingerprint',
  canReread: true,
  canReparse: true,
  replayable: true,
  persistencePreference: 'reference',
}

const verified: SourceRawRecoveryCheck = {
  state: 'verified',
  checkedAt: '2026-09-16T00:00:00.000Z',
}

test('Raw 只有在 Canonical/Evidence 稳定且当前来源已验证时才可自动回收', () => {
  assert.deepEqual(evaluateSourceRawRetention({
    capability: recoverable,
    verification: verified,
    canonicalStable: true,
    evidenceStable: true,
    pinned: false,
  }), {
    autoReclaimEligible: true,
    reasons: [],
  })
})

test('未知 Source 默认保守，不自动回收', () => {
  const decision = evaluateSourceRawRetention({
    canonicalStable: true,
    evidenceStable: true,
    pinned: false,
  })
  assert.equal(decision.autoReclaimEligible, false)
  assert.deepEqual(decision.reasons, ['recovery-capability-unknown'])
})

test('Pinned / Drifted / Unavailable 任一条件都阻止自动回收', () => {
  for (const verification of [
    { state: 'drifted', checkedAt: '2026-09-16T00:00:00.000Z' },
    { state: 'unavailable', checkedAt: '2026-09-16T00:00:00.000Z' },
  ] as const) {
    const decision = evaluateSourceRawRetention({
      capability: recoverable,
      verification,
      canonicalStable: true,
      evidenceStable: true,
      pinned: true,
    })
    assert.equal(decision.autoReclaimEligible, false)
    assert.ok(decision.reasons.includes('pinned'))
  }
})

test('没有 Fingerprint 验证能力时，即使可重读也不能自动回收', () => {
  const decision = evaluateSourceRawRetention({
    capability: { ...recoverable, verification: 'identity-only' },
    canonicalStable: true,
    evidenceStable: true,
    pinned: false,
  })
  assert.equal(decision.autoReclaimEligible, false)
  assert.ok(decision.reasons.includes('fingerprint-required'))
})
