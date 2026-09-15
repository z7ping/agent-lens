import assert from 'node:assert/strict'
import test from 'node:test'
import { parseLiveThinkingControlDto } from './live'

test('Live protocol preserves Runtime thinking values, order, and duplicates without normalization', () => {
  const parsed = parseLiveThinkingControlDto({
    capability: 'thinking-control',
    value: 'max',
    options: [
      { value: 'off', label: 'off' },
      { value: 'minimal', label: 'minimal' },
      { value: 'xhigh', label: 'xhigh' },
      { value: 'max', label: 'max' },
      { value: 'max', label: 'max duplicate' },
    ],
  })

  assert.ok(parsed)
  assert.equal(parsed.value, 'max')
  assert.deepEqual(parsed.options.map(option => option.value), ['off', 'minimal', 'xhigh', 'max', 'max'])
})

test('Live protocol rejects incomplete or mismatched thinking control descriptions', () => {
  assert.equal(parseLiveThinkingControlDto({
    capability: 'thinking-control',
    value: 'xhigh',
    options: [{ value: 'max' }],
  }), null)
  assert.equal(parseLiveThinkingControlDto({
    capability: 'thinking-control',
    value: 'xhigh',
    options: [],
  }), null)
  assert.equal(parseLiveThinkingControlDto({
    capability: 'model-switching',
    value: 'xhigh',
    options: [{ value: 'xhigh' }],
  }), null)
})
