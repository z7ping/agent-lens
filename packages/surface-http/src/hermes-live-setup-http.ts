import type { IncomingMessage, ServerResponse } from 'node:http'
import { badRequest, httpError, readJsonBody, writeJson } from './http-utils'

export interface HermesLiveSetupResult {
  status: 'ready' | 'needs-gateway'
  reason?: string
}

export type HermesLiveSetupController = () => Promise<HermesLiveSetupResult>

/** An explicit, local-only configuration mutation; never runs on page load. */
export async function handleHermesLiveSetupRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  controller?: HermesLiveSetupController,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/live/hermes/initialize') return false
  if (request.method !== 'POST') {
    response.setHeader('allow', 'POST')
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!controller) {
    writeJson(response, 503, { error: 'hermes_setup_not_authorized' })
    return true
  }
  // Same-origin UI only. JSON content type makes cross-site simple form POSTs invalid too.
  const origin = request.headers.origin
  if (origin) {
    const host = request.headers.host
    if (!host || origin !== 'http://' + host) throw httpError(403, 'Cross-origin setup is forbidden')
  }
  const input = await readJsonBody(request, { maxBytes: 1024 })
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).length !== 1
    || (input as Record<string, unknown>).confirm !== true) {
    throw badRequest('Explicit confirmation is required')
  }
  let result: HermesLiveSetupResult
  try {
    result = await controller()
  } catch (error) {
    // Configuration diagnostics are actionable, but must never contain the secret.
    const message = error instanceof Error ? error.message : 'Hermes initialization failed'
    throw httpError(409, message)
  }
  writeJson(response, 200, result)
  return true
}
