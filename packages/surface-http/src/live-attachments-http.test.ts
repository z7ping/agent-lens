import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  LiveAttachment,
  LiveAttachmentDescriptor,
  LiveAttachmentService,
  PutLiveAttachmentInput,
} from '@agent-lens/core'
import { SqliteStorageService } from '@agent-lens/storage-sqlite'
import { startHttpSurface } from './server'

class FakeLiveAttachmentService implements LiveAttachmentService {
  private readonly items = new Map<string, LiveAttachment>()
  private sequence = 0

  async put(input: PutLiveAttachmentInput): Promise<LiveAttachmentDescriptor> {
    const attachmentId = `attachment-${++this.sequence}`
    const attachment: LiveAttachment = {
      attachmentId,
      data: new Uint8Array(input.data),
      sizeBytes: input.data.byteLength,
      ...(input.name ? { name: input.name } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    }
    this.items.set(attachmentId, attachment)
    const { data: _data, ...descriptor } = attachment
    return descriptor
  }

  async get(attachmentId: string): Promise<LiveAttachment | null> {
    const item = this.items.get(attachmentId)
    return item ? { ...item, data: new Uint8Array(item.data) } : null
  }

  async remove(attachmentId: string): Promise<void> {
    this.items.delete(attachmentId)
  }

  async dispose(): Promise<void> {
    this.items.clear()
  }
}

test('Live attachment HTTP route uploads, previews, and removes opaque attachments', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const liveAttachments = new FakeLiveAttachmentService()
  const surface = await startHttpSurface(storage, { port: 0, liveAttachments })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const uploaded = await fetch(`${base}/api/v1/live/attachments`, {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-agentlens-file-name': encodeURIComponent('截图.png'),
      },
      body: new Uint8Array([1, 2, 3]),
    })
    assert.equal(uploaded.status, 201)
    assert.deepEqual(await uploaded.json(), {
      attachmentId: 'attachment-1',
      name: '截图.png',
      mimeType: 'image/png',
      sizeBytes: 3,
    })

    const preview = await fetch(`${base}/api/v1/live/attachments/attachment-1`)
    assert.equal(preview.status, 200)
    assert.equal(preview.headers.get('content-type'), 'image/png')
    assert.equal(preview.headers.get('cache-control'), 'no-store')
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), new Uint8Array([1, 2, 3]))

    const removed = await fetch(`${base}/api/v1/live/attachments/attachment-1`, { method: 'DELETE' })
    assert.equal(removed.status, 200)

    const missing = await fetch(`${base}/api/v1/live/attachments/attachment-1`)
    assert.equal(missing.status, 404)
  } finally {
    await surface.dispose()
    storage.close()
  }
})

test('Live attachment HTTP route reports unavailable service without falling through', async () => {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  const surface = await startHttpSurface(storage, { port: 0 })
  const base = `http://${surface.host}:${surface.port}`

  try {
    const response = await fetch(`${base}/api/v1/live/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array([1]),
    })
    assert.equal(response.status, 503)
  } finally {
    await surface.dispose()
    storage.close()
  }
})
