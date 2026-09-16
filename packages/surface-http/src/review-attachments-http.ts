import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { StorageService } from '@agent-lens/core'
import { reviewMessageImageSourceAt } from '@agent-lens/projection-review'
import { httpError, writeJson } from './http-utils'

const PREFIX = '/api/v1/review-attachments/'

export async function handleReviewAttachmentRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storage: StorageService,
): Promise<boolean> {
  if (!url.pathname.startsWith(PREFIX)) return false
  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const segments = url.pathname.slice(PREFIX.length).split('/')
  if (segments.length !== 2) throw httpError(400, 'Review attachment path is invalid')
  let observationId = ''
  try {
    observationId = decodeURIComponent(segments[0] ?? '').trim()
  } catch {
    throw httpError(400, 'Review attachment observation id is invalid')
  }
  const indexText = segments[1] ?? ''
  if (!observationId || !/^\\d+$/.test(indexText)) {
    throw httpError(400, 'Review attachment path is invalid')
  }
  const index = Number(indexText)
  if (!Number.isSafeInteger(index)) throw httpError(400, 'Review attachment index is invalid')

  const observation = await storage.repositories.observations.get(observationId)
  const image = observation ? reviewMessageImageSourceAt(observation.payload, index) : null
  if (!image) {
    writeJson(response, 404, { error: 'not_found' })
    return true
  }

  const bytes = Buffer.from(image.data, 'base64')
  if (!bytes.length) {
    writeJson(response, 404, { error: 'not_found' })
    return true
  }
  response.statusCode = 200
  response.setHeader('content-type', image.mimeType)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('content-length', bytes.byteLength)
  response.setHeader('content-disposition', 'inline')
  response.end(bytes)
  return true
}
