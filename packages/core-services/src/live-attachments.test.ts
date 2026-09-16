import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultLiveAttachmentService } from './live-attachments'

test('Live attachment cache copies bytes and removes explicitly', async () => {
  const service = new DefaultLiveAttachmentService({
    maxItemBytes: 16,
    maxTotalBytes: 32,
    maxEntries: 2,
    ttlMs: 1_000,
  })
  const input = new Uint8Array([1, 2, 3])
  const descriptor = await service.put({
    data: input,
    name: 'shot.png',
    mimeType: 'IMAGE/PNG',
  })
  input[0] = 9

  const first = await service.get(descriptor.attachmentId)
  assert.deepEqual(first?.data, new Uint8Array([1, 2, 3]))
  assert.equal(first?.mimeType, 'image/png')
  first!.data[1] = 8
  assert.deepEqual((await service.get(descriptor.attachmentId))?.data, new Uint8Array([1, 2, 3]))

  await service.remove(descriptor.attachmentId)
  assert.equal(await service.get(descriptor.attachmentId), null)
})

test('Live attachment cache prunes expired entries before enforcing limits', async () => {
  let now = 10
  const service = new DefaultLiveAttachmentService({
    maxItemBytes: 4,
    maxTotalBytes: 4,
    maxEntries: 1,
    ttlMs: 5,
  }, () => now)

  const first = await service.put({ data: new Uint8Array([1, 2, 3, 4]) })
  now = 16
  const second = await service.put({ data: new Uint8Array([5, 6]) })

  assert.equal(await service.get(first.attachmentId), null)
  assert.deepEqual((await service.get(second.attachmentId))?.data, new Uint8Array([5, 6]))
})

test('Live attachment cache rejects oversized and non-expired overflow instead of evicting drafts', async () => {
  const service = new DefaultLiveAttachmentService({
    maxItemBytes: 4,
    maxTotalBytes: 6,
    maxEntries: 2,
    ttlMs: 1_000,
  })

  await service.put({ data: new Uint8Array([1, 2, 3, 4]) })
  await assert.rejects(
    () => service.put({ data: new Uint8Array([5, 6, 7]) }),
    /byte limit exceeded/,
  )
  await assert.rejects(
    () => service.put({ data: new Uint8Array([1, 2, 3, 4, 5]) }),
    /exceeds item limit/,
  )
})
