import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLiveInputCapabilities,
  liveMessageToPlainText,
  normalizeLiveMessage,
  requireLiveMessageSupport,
} from './index'

const textOnly = createLiveInputCapabilities({
  text: 'native',
  largeText: 'transform',
  image: 'unsupported',
  file: 'unsupported',
  multiline: 'native',
})

test('normalizes legacy string input into one text part', () => {
  assert.deepEqual(normalizeLiveMessage('hello'), {
    parts: [{ type: 'text', text: 'hello' }],
  })
})

test('keeps large text structured until an adapter explicitly flattens it', () => {
  const message = normalizeLiveMessage({
    parts: [
      { type: 'text', text: 'before' },
      { type: 'large-text', text: 'line 1\nline 2', lineCount: 2, charCount: 13 },
      { type: 'text', text: 'after' },
    ],
  })

  assert.deepEqual(message.parts[1], {
    type: 'large-text',
    text: 'line 1\nline 2',
    lineCount: 2,
    charCount: 13,
  })
  assert.equal(liveMessageToPlainText(message, textOnly), 'before\n\nline 1\nline 2\n\nafter')
})

test('rejects unsupported attachment parts before an adapter sends them', () => {
  const message = normalizeLiveMessage({
    parts: [{ type: 'image', attachmentId: 'image-1', mimeType: 'image/png' }],
  })
  assert.throws(
    () => requireLiveMessageSupport(message, textOnly, 'test-live'),
    /test-live does not support Live input part: image/,
  )
})
