import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForServiceStop, type ServiceStopState } from './service-stop-settlement'

test('Windows stop waits after Task Scheduler becomes Ready until service Daemon is offline', async () => {
  let clock = 0
  const states: ServiceStopState[] = [
    { taskActive: false, serviceOwnedRuntimeOnline: true },
    { taskActive: false, serviceOwnedRuntimeOnline: true },
    { taskActive: false, serviceOwnedRuntimeOnline: false },
  ]
  let calls = 0
  const status = await waitForServiceStop(
    { taskActive: true, serviceOwnedRuntimeOnline: true },
    async () => {
      calls += 1
      return states.shift()!
    },
    async ms => { clock += ms },
    { timeoutMs: 2_000, pollMs: 250, now: () => clock },
  )
  assert.deepEqual(status, { taskActive: false, serviceOwnedRuntimeOnline: false })
  assert.equal(calls, 3, 'Task Scheduler Ready alone must not signal stop success')
})

test('Windows stop refuses to report settled when Daemon remains online past deadline', async () => {
  let clock = 0
  let polls = 0
  const state = await waitForServiceStop(
    { taskActive: false, serviceOwnedRuntimeOnline: true },
    async () => {
      polls += 1
      return { taskActive: false, serviceOwnedRuntimeOnline: true }
    },
    async ms => { clock += ms },
    { timeoutMs: 600, pollMs: 250, now: () => clock },
  )
  assert.equal(clock, 600)
  assert.equal(polls, 3)
  assert.equal(state.serviceOwnedRuntimeOnline, true, 'a timeout is not a successful stop')
})

test('already-stopped runtime does not introduce extra polling', async () => {
  let polls = 0
  const state = await waitForServiceStop(
    { taskActive: false, serviceOwnedRuntimeOnline: false },
    async () => {
      polls += 1
      return { taskActive: false, serviceOwnedRuntimeOnline: false }
    },
    async () => {},
  )
  assert.equal(polls, 0)
  assert.equal(state.taskActive, false)
  assert.equal(state.serviceOwnedRuntimeOnline, false)
})
