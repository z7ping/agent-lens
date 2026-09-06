import assert from 'node:assert/strict'
import test from 'node:test'
import { ForegroundActivityGate, maintenanceIdleInternals } from './maintenance-idle'

test('foreground gate defaults to a five second quiet window', () => {
  assert.equal(maintenanceIdleInternals.DEFAULT_QUIET_MS, 5_000)
})

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

test('foreground gate also waits for reader and writer pending work', () => {
  let now = 10_000
  let foregroundPending = 1
  let writerPending = 0
  const gate = new ForegroundActivityGate({
    quietMs: 5_000,
    now: () => now,
    loadProbe: () => ({ foregroundPending, writerPending }),
  })

  assert.equal(gate.isIdle(), false)
  foregroundPending = 0
  writerPending = 1
  assert.equal(gate.isIdle(), false)
  writerPending = 0
  assert.equal(gate.isIdle(), true)

  const snapshot = gate.snapshot()
  assert.deepEqual(snapshot.load, { foregroundPending: 0, writerPending: 0 })
})

test('foreground gate wait stops once the quiet window and data queues are clear', async () => {
  let now = 0
  let foregroundPending = 1
  const gate = new ForegroundActivityGate({
    quietMs: 300,
    pollMs: 100,
    now: () => now,
    loadProbe: () => ({ foregroundPending, writerPending: 0 }),
    sleep: async ms => {
      now += ms
      if (now >= 200) foregroundPending = 0
    },
  })

  await gate.wait(new AbortController().signal)
  assert.equal(now, 300)
  assert.equal(gate.isIdle(), true)
})
