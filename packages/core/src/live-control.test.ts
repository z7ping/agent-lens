import assert from 'node:assert/strict'
import test from 'node:test'
import { isLiveThinkingControl, type LiveThinkingControl } from './contracts/live'

test('Live thinking-control keeps Runtime option values opaque and distinct', () => {
  const control: LiveThinkingControl = {
    capability: 'thinking-control',
    value: 'xhigh',
    options: ['off', 'minimal', 'xhigh', 'max'].map(value => ({ value, label: value })),
  }

  assert.equal(isLiveThinkingControl(control), true)
  assert.deepEqual(control.options.map(option => option.value), ['off', 'minimal', 'xhigh', 'max'])
})

test('Live thinking-control is invalid when the current Runtime value is not offered', () => {
  assert.equal(isLiveThinkingControl({
    capability: 'thinking-control',
    value: 'maximum',
    options: [{ value: 'max' }],
  }), false)
})
