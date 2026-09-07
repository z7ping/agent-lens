import assert from 'node:assert/strict'
import test from 'node:test'
import { ForegroundActivityGate, maintenanceIdleInternals } from './maintenance-idle'

test('foreground gate defaults to a five second quiet window and maximum defer', () => {
  assert.equal(maintenanceIdleInternals.DEFAULT_QUIET_MS, 5_000)
  assert.equal(maintenanceIdleInternals.DEFAULT_MAX_DEFER_MS, 5_000)
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
  now = 15_000
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
  assert.equal(gate.snapshot().permits.quiet, 1)
})

test('foreground gate grants a bounded maintenance slice after maximum defer under sustained reads', async () => {
  let now = 0
  const gate = new ForegroundActivityGate({
    quietMs: 5_000,
    maxDeferMs: 500,
    pollMs: 100,
    now: () => now,
    loadProbe: () => ({ foregroundPending: 1, writerPending: 0 }),
    sleep: async ms => { now += ms },
  })

  await gate.wait(new AbortController().signal)
  assert.equal(now, 500)
  assert.equal(gate.isIdle(), false)
  assert.deepEqual(gate.snapshot().permits, {
    quiet: 0,
    forced: 1,
    lastAt: 500,
    lastForcedAt: 500,
    maxWaitMs: 500,
  })

  await gate.wait(new AbortController().signal)
  assert.equal(now, 1_000, 'the next maintenance slice must earn another defer budget')
  assert.equal(gate.snapshot().permits.forced, 2)
})

test('foreground gate never forces maintenance ahead of pending writer work', async () => {
  let now = 0
  const controller = new AbortController()
  const gate = new ForegroundActivityGate({
    quietMs: 5_000,
    maxDeferMs: 300,
    pollMs: 100,
    now: () => now,
    loadProbe: () => ({ foregroundPending: 1, writerPending: 1 }),
    sleep: async ms => {
      now += ms
      if (now >= 700) controller.abort()
    },
  })

  await gate.wait(controller.signal)
  assert.equal(now, 700)
  assert.equal(gate.snapshot().permits.forced, 0)
})
