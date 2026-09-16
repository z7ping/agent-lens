import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewMessageAttachmentsFromPayload } from './review'

test('Review historical attachments project canonical Pi image data without exposing native paths', () => {
  const attachments = reviewMessageAttachmentsFromPayload({
    attachments: [{
      type: 'image',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
      name: 'C:\\Users\\demo\\shot.png',
    }],
  })

  assert.deepEqual(attachments, [{
    type: 'image',
    mimeType: 'image/png',
    name: 'shot.png',
    dataUrl: 'data:image/png;base64,aGVsbG8=',
  }])
})

test('Review historical attachments keep legacy Pi nonTextContent readable', () => {
  const attachments = reviewMessageAttachmentsFromPayload({
    nonTextContent: [{
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'ZmFrZQ==',
    }],
  })

  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]?.type, 'image')
  assert.equal(attachments[0]?.dataUrl, 'data:image/jpeg;base64,ZmFrZQ==')
})

test('Review historical attachments do not promote arbitrary local or remote paths into image URLs', () => {
  const attachments = reviewMessageAttachmentsFromPayload({
    attachments: [
      { kind: 'local_images', value: 'C:\\tmp\\secret.png' },
      { kind: 'images', value: 'https://example.com/image.png' },
    ],
  })

  assert.deepEqual(attachments, [{ type: 'image' }, { type: 'image' }])
  assert.ok(attachments.every(item => item.dataUrl === undefined))
})
