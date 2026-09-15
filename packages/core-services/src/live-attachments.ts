import { randomUUID } from 'node:crypto'
import { LIVE_ATTACHMENT_MAX_ITEM_BYTES } from '@agent-lens/core'
import type {
  LiveAttachment,
  LiveAttachmentDescriptor,
  LiveAttachmentService,
  PutLiveAttachmentInput,
} from '@agent-lens/core'

export interface LiveAttachmentLimits {
  maxItemBytes: number
  maxTotalBytes: number
  maxEntries: number
  ttlMs: number
}

export const DEFAULT_LIVE_ATTACHMENT_LIMITS: LiveAttachmentLimits = {
  maxItemBytes: LIVE_ATTACHMENT_MAX_ITEM_BYTES,
  maxTotalBytes: 64 * 1024 * 1024,
  maxEntries: 64,
  ttlMs: 60 * 60 * 1000,
}

interface StoredAttachment extends LiveAttachment {
  expiresAt: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`)
  }
  return value
}

export class DefaultLiveAttachmentService implements LiveAttachmentService {
  private readonly items = new Map<string, StoredAttachment>()
  private readonly limits: LiveAttachmentLimits
  private totalBytes = 0
  private disposed = false

  constructor(
    limits: Partial<LiveAttachmentLimits> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.limits = {
      maxItemBytes: positiveInteger(limits.maxItemBytes ?? DEFAULT_LIVE_ATTACHMENT_LIMITS.maxItemBytes, 'maxItemBytes'),
      maxTotalBytes: positiveInteger(limits.maxTotalBytes ?? DEFAULT_LIVE_ATTACHMENT_LIMITS.maxTotalBytes, 'maxTotalBytes'),
      maxEntries: positiveInteger(limits.maxEntries ?? DEFAULT_LIVE_ATTACHMENT_LIMITS.maxEntries, 'maxEntries'),
      ttlMs: positiveInteger(limits.ttlMs ?? DEFAULT_LIVE_ATTACHMENT_LIMITS.ttlMs, 'ttlMs'),
    }
    if (this.limits.maxItemBytes > this.limits.maxTotalBytes) {
      throw new TypeError('maxItemBytes must not exceed maxTotalBytes')
    }
  }

  async put(input: PutLiveAttachmentInput): Promise<LiveAttachmentDescriptor> {
    this.assertActive()
    this.pruneExpired()

    if (!(input.data instanceof Uint8Array)) {
      throw new TypeError('Live attachment data must be Uint8Array')
    }
    const sizeBytes = input.data.byteLength
    if (sizeBytes <= 0) throw new Error('Live attachment must not be empty')
    if (sizeBytes > this.limits.maxItemBytes) {
      throw new Error(`Live attachment exceeds item limit: ${sizeBytes} > ${this.limits.maxItemBytes}`)
    }
    if (this.items.size >= this.limits.maxEntries) {
      throw new Error('Live attachment cache is full')
    }
    if (this.totalBytes + sizeBytes > this.limits.maxTotalBytes) {
      throw new Error('Live attachment cache byte limit exceeded')
    }

    const attachmentId = input.attachmentId?.trim() || randomUUID()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(attachmentId)) {
      throw new Error('Live attachment id is invalid')
    }
    if (this.items.has(attachmentId)) {
      throw new Error('Live attachment id already exists')
    }
    const stored: StoredAttachment = {
      attachmentId,
      data: new Uint8Array(input.data),
      sizeBytes,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      ...(input.mimeType?.trim() ? { mimeType: input.mimeType.trim().toLowerCase() } : {}),
      expiresAt: this.now() + this.limits.ttlMs,
    }
    this.items.set(attachmentId, stored)
    this.totalBytes += sizeBytes
    return this.descriptor(stored)
  }

  async get(attachmentId: string): Promise<LiveAttachment | null> {
    this.assertActive()
    this.pruneExpired()
    const stored = this.items.get(attachmentId)
    if (!stored) return null
    return {
      ...this.descriptor(stored),
      data: new Uint8Array(stored.data),
    }
  }

  async remove(attachmentId: string): Promise<void> {
    this.assertActive()
    this.deleteStored(attachmentId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.items.clear()
    this.totalBytes = 0
  }

  private descriptor(stored: StoredAttachment): LiveAttachmentDescriptor {
    return {
      attachmentId: stored.attachmentId,
      sizeBytes: stored.sizeBytes,
      ...(stored.name ? { name: stored.name } : {}),
      ...(stored.mimeType ? { mimeType: stored.mimeType } : {}),
    }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [attachmentId, stored] of this.items) {
      if (stored.expiresAt <= now) this.deleteStored(attachmentId)
    }
  }

  private deleteStored(attachmentId: string): void {
    const stored = this.items.get(attachmentId)
    if (!stored) return
    this.items.delete(attachmentId)
    this.totalBytes = Math.max(0, this.totalBytes - stored.sizeBytes)
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Live attachment service is disposed')
  }
}
