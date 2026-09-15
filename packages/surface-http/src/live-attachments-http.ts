import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LIVE_ATTACHMENT_MAX_ITEM_BYTES,
  type LiveAttachmentService,
} from '@agent-lens/core'
import { httpError, readBinaryBody, writeJson } from './http-utils'

const COLLECTION_PATH = '/api/v1/live/attachments'
const ITEM_PREFIX = `${COLLECTION_PATH}/`
const MAX_ATTACHMENT_NAME_LENGTH = 255

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function attachmentName(request: IncomingMessage): string | undefined {
  const raw = firstHeader(request.headers['x-agentlens-file-name'])
  if (!raw) return undefined
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw httpError(400, 'Live attachment file name is invalid')
  }
  const value = decoded.trim()
  if (!value) return undefined
  if (value.length > MAX_ATTACHMENT_NAME_LENGTH) {
    throw httpError(400, 'Live attachment file name is too long')
  }
  return value
}

function attachmentMimeType(request: IncomingMessage): string | undefined {
  const raw = firstHeader(request.headers['content-type'])
  const value = raw?.split(';')[0]?.trim().toLowerCase()
  return value || undefined
}

function mapAttachmentError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/exceeds item limit|too large/i.test(message)) throw httpError(413, message)
  if (/cache is full|byte limit exceeded/i.test(message)) throw httpError(503, message)
  throw error
}

export async function handleLiveAttachmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  attachments: LiveAttachmentService | undefined,
): Promise<boolean> {
  if (url.pathname !== COLLECTION_PATH && !url.pathname.startsWith(ITEM_PREFIX)) return false

  if (!attachments) {
    writeJson(response, 503, {
      error: 'live_attachments_unavailable',
      message: 'Live attachment service is unavailable',
    })
    return true
  }

  if (url.pathname === COLLECTION_PATH) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    try {
      const data = await readBinaryBody(request, {
        maxBytes: LIVE_ATTACHMENT_MAX_ITEM_BYTES,
        emptyBodyMessage: 'Live attachment body is required',
      })
      const descriptor = await attachments.put({
        data,
        ...(attachmentName(request) ? { name: attachmentName(request) } : {}),
        ...(attachmentMimeType(request) ? { mimeType: attachmentMimeType(request) } : {}),
      })
      writeJson(response, 201, descriptor)
    } catch (error) {
      mapAttachmentError(error)
    }
    return true
  }

  if (request.method !== 'DELETE') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  let attachmentId = ''
  try {
    attachmentId = decodeURIComponent(url.pathname.slice(ITEM_PREFIX.length)).trim()
  } catch {
    attachmentId = ''
  }
  if (!attachmentId || attachmentId.includes('/')) {
    throw httpError(400, 'Live attachment id is invalid')
  }

  await attachments.remove(attachmentId)
  writeJson(response, 200, { removed: true })
  return true
}
