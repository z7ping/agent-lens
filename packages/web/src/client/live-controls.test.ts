import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveLiveThinkingControl } from './live-controls'

const descriptor = {
  capability: 'thinking-control',
  value: 'xhigh',
  options: ['off', 'minimal', 'xhigh', 'max'].map(value => ({ value, label: value })),
}

test('Live Surface requires declared thinking-control capability before rendering a valid descriptor', () => {
  assert.equal(resolveLiveThinkingControl(false, descriptor), null)
  assert.deepEqual(
    resolveLiveThinkingControl(true, descriptor)?.options.map(option => option.value),
    ['off', 'minimal', 'xhigh', 'max'],
  )
})

test('Live Surface hides invalid thinking-control descriptors instead of inventing options', () => {
  assert.equal(resolveLiveThinkingControl(true, {
    ...descriptor,
    value: 'high',
  }), null)
  assert.equal(resolveLiveThinkingControl(true, undefined), null)
})
