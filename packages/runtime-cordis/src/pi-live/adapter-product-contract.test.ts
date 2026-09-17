import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizePiLiveEvent } from './adapter'

test('Pi extension UI request is normalized before reaching Product Surface', () => {
  assert.deepEqual(normalizePiLiveEvent({
    type: 'extension_ui_request',
    id: 'request-1',
    method: 'select',
    title: 'Choose target',
    message: 'Pick one',
    options: ['A', 'B'],
    placeholder: 'Target',
    prefill: 'A',
  }), {
    type: 'ui.request',
    requestId: 'request-1',
    method: 'select',
    title: 'Choose target',
    message: 'Pick one',
    options: ['A', 'B'],
    placeholder: 'Target',
    prefill: 'A',
  })
})

test('Pi invalid extension request is not promoted into common semantics', () => {
  assert.equal(normalizePiLiveEvent({
    type: 'extension_ui_request',
    id: '',
    method: 'custom',
  }), undefined)
})
