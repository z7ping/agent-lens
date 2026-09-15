import assert from 'node:assert/strict'
import test from 'node:test'
import { ComposerDraftPresenceGate } from './pi-markdown-composer-state'

test('Composer draft presence only propagates empty/non-empty transitions', () => {
  const gate = new ComposerDraftPresenceGate()
  let notifications = 0

  for (let index = 0; index < 10_000; index += 1) {
    if (gate.accept(true)) notifications += 1
  }
  assert.equal(notifications, 1)

  if (gate.accept(false)) notifications += 1
  assert.equal(notifications, 2)
  assert.equal(gate.snapshot(), false)
})
