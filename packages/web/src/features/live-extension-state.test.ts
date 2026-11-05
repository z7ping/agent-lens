import assert from 'node:assert/strict'
import test from 'node:test'
import { reduceLiveExtensionState, type LiveExtensionState } from './live-extension-state'

test('Pi extension keyed statuses update and clear without duplicating old content', () => {
  const initial: LiveExtensionState = { type: 'ui.state', kind: 'status', key: 'sync', text: '1/3' }
  let states = reduceLiveExtensionState([], initial)
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'sync', text: '2/3' })
  assert.deepEqual(states, [{ type: 'ui.state', kind: 'status', key: 'sync', text: '2/3' }])
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'build', text: 'running' })
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'sync', text: null })
  assert.deepEqual(states, [{ type: 'ui.state', kind: 'status', key: 'build', text: 'running' }])
  states = reduceLiveExtensionState(states, { type: 'ui.state', kind: 'status', key: 'build', text: '' })
  assert.deepEqual(states, [])
})

test('Pi widget and status keys are independent; clearing a widget keeps its status', () => {
  let states: LiveExtensionState[] = []
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'status', key: 'plan', text: 'Step 2',
  })
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: ['Line 1', 'Line 2'],
    placement: 'aboveEditor',
  })
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: ['Updated'],
    placement: 'belowEditor',
  })
  assert.equal(states.length, 2)
  assert.deepEqual(states[1], {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: ['Updated'],
    placement: 'belowEditor',
  })
  states = reduceLiveExtensionState(states, {
    type: 'ui.state', kind: 'widget', key: 'plan', lines: null,
  })
  assert.deepEqual(states, [{ type: 'ui.state', kind: 'status', key: 'plan', text: 'Step 2' }])
})
