import assert from 'node:assert/strict'
import test from 'node:test'
import { optimisticMessageAttachments } from './live-task-input'

test('outgoing Live image is decoded before editor handoff and needs no temporary blob URL', async () => {
  const originalFetch = globalThis.fetch
  const originalReader = globalThis.FileReader
  const originalImage = globalThis.Image
  const preview = 'data:image/png;base64,aW1hZ2U='
  const warmed: string[] = []
  try {
    globalThis.fetch = async () => new Response(new Blob(['image'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })
    globalThis.FileReader = class {
      result: string | ArrayBuffer | null = null
      error = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      readAsDataURL() {
        this.result = preview
        queueMicrotask(() => this.onload?.())
      }
    } as unknown as typeof FileReader
    globalThis.Image = class {
      src = ''
      async decode() {
        warmed.push(this.src)
      }
    } as unknown as typeof Image

    const attachments = await optimisticMessageAttachments({ parts: [
      { type: 'text', text: '看图' },
      { type: 'image', attachmentId: 'test-image', mimeType: 'image/png', name: 'shot.png' },
    ] })
    assert.equal(attachments.length, 1)
    assert.equal(attachments[0]?.dataUrl, preview)
    assert.equal(attachments[0]?.previewUrl, undefined)
    assert.deepEqual(warmed, [preview])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.FileReader = originalReader
    globalThis.Image = originalImage
  }
})
