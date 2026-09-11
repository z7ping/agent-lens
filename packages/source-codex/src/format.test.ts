import assert from 'node:assert/strict'
import test from 'node:test'
import { messageText, nativeIdForEntry, nativeTypeForEntry } from './format'

test('Codex format helpers safely parse persisted object payloads', () => {
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        id: 'item-1',
        type: 'function_call_output',
        content: [{ type: 'output_text', text: 'done' }],
      },
    },
  }

  assert.equal(nativeIdForEntry(entry), 'item-1')
  assert.equal(nativeTypeForEntry(entry), 'event_msg/item_completed/function_call_output')
  assert.equal(messageText(entry.payload.item.content), 'done')
})

test('Codex format helpers tolerate non-object values without throwing', () => {
  assert.equal(messageText(null), '')
  assert.equal(messageText([{ text: 'first' }, { content: 'second' }]), 'first\n\nsecond')
  assert.equal(nativeIdForEntry({ type: 'response_item', payload: null }), undefined)
  assert.equal(nativeTypeForEntry({ type: 'response_item', payload: null }), 'response_item')
})
