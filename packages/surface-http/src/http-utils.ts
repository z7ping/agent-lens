import type { IncomingMessage, ServerResponse } from 'node:http'

export type HttpError = Error & { statusCode: number }

export function httpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError
  error.statusCode = statusCode
  return error
}

export function badRequest(message: string): HttpError {
  return httpError(400, message)
}

export function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  const content = JSON.stringify(body)
  response.statusCode = statusCode
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.setHeader('content-length', Buffer.byteLength(content))
  response.end(content)
}

export async function readJsonBody(
  request: IncomingMessage,
  options: {
    maxBytes: number
    contentTypeMessage?: string
    emptyBodyMessage?: string
    invalidJsonMessage?: string
  },
): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    throw httpError(415, options.contentTypeMessage ?? 'Content-Type must be application/json')
  }

  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.byteLength
    if (size > options.maxBytes) throw httpError(413, 'Request body is too large')
    chunks.push(bytes)
  }
  if (!chunks.length) throw badRequest(options.emptyBodyMessage ?? 'JSON body is required')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw badRequest(options.invalidJsonMessage ?? 'Request body must be valid JSON')
  }
}
