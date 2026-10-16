import assert from 'node:assert/strict'
import test from 'node:test'
import { reviewMessageAttachmentsFromPayload } from './review'

test('Codex local_image 附件保留图片语义，但不把原生路径作为图片 URL', () => {
  const attachments = reviewMessageAttachmentsFromPayload({
    attachments: [{ kind: 'attachments', value: { type: 'local_image', path: 'C:\\tmp\\screenshot.png' } }],
  })
  assert.deepEqual(attachments, [{ type: 'image', name: 'screenshot.png' }])
})

test('Codex 原生内联图片只接受 data image，不提升任意远程 URL', () => {
  assert.equal(reviewMessageAttachmentsFromPayload({
    attachments: [{ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }],
  })[0]?.dataUrl, 'data:image/png;base64,aGVsbG8=')
  assert.equal(reviewMessageAttachmentsFromPayload({
    attachments: [{ type: 'input_image', image_url: 'https://example.com/private.png' }],
  })[0]?.dataUrl, undefined)
})

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

test('Review attachment metadata projection can omit inline data without losing attachment semantics', () => {
  const attachments = reviewMessageAttachmentsFromPayload({
    attachments: [{
      type: 'image',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
    }],
  }, { includeDataUrl: false })

  assert.deepEqual(attachments, [{
    type: 'image',
    mimeType: 'image/png',
  }])
})
