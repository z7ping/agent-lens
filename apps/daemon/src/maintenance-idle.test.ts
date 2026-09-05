import assert from 'node:assert/strict'
import test from 'node:test'
import { ForegroundActivityGate } from './maintenance-idle'

test('foreground gate waits for active request completion plus quiet window', async () => {
  let now = 0
  const gate = new ForegroundActivityGate({
    quietMs: 500,
    pollMs: 100,
    now: () => now,
    sleep: async ms => { now += ms },
  })

  const end = gate.begin()
  assert.equal(gate.isIdle(), false)
  now = 200
  end()
  assert.equal(gate.isIdle(), false)
  now = 699
  assert.equal(gate.isIdle(), false)
  now = 700
  assert.equal(gate.isIdle(), true)
})

test('foreground gate wait stops once the quiet window is reached', async () => {
  let now = 0
  const gate = new ForegroundActivityGate({
    quietMs: 300,
    pollMs: 100,
    now: () => now,
    sleep: async ms => { now += ms },
  })

  await gate.wait(new AbortController().signal)
  assert.equal(now, 300)
  assert.equal(gate.isIdle(), true)
})
