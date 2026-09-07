import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceRunnerInternals } from './source-runner'

test('parser replay transaction ends on record or time budget', () => {
  const startedAt = 1_000
  const nowAt = (value: number) => () => value

  assert.equal(
    sourceRunnerInternals.parserReplayTransactionExpired(startedAt, 49, nowAt(1_019)),
    false,
  )
  assert.equal(
    sourceRunnerInternals.parserReplayTransactionExpired(startedAt, 50, nowAt(1_001)),
    true,
  )
  assert.equal(
    sourceRunnerInternals.parserReplayTransactionExpired(startedAt, 1, nowAt(1_020)),
    true,
  )
})
