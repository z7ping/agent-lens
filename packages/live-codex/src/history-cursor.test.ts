import test from 'node:test'
import assert from 'node:assert/strict'
import {
  encodeCodexItemAnchor, encodeCodexPageCursor, decodeCodexHistoryCursor,
} from './history-cursor.js'

test('Codex native history cursors round-trip without exposing parser assumptions', () => {
  const anchor = { turnId: 'turn-2', itemId: 'item-3', backwardsCursor: 'opaque:cursor+123' }
  assert.deepEqual(decodeCodexHistoryCursor(encodeCodexItemAnchor(anchor)), {
    kind: 'item', anchor,
  })
  assert.deepEqual(decodeCodexHistoryCursor(encodeCodexPageCursor('opaque-page')), {
    kind: 'page', cursor: 'opaque-page',
  })
})

test('Unknown and incomplete Codex history cursors fail closed', () => {
  assert.throws(() => decodeCodexHistoryCursor('old-unverified-leaf'), /Unsupported/)
  const incomplete = 'codex-item:' + Buffer.from(JSON.stringify({
    turnId: 'turn-1', itemId: 'item-1',
  })).toString('base64url')
  assert.throws(() => decodeCodexHistoryCursor(incomplete), /Unsupported/)
})
