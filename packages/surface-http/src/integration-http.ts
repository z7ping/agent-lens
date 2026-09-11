import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type IntegrationAuthorizationCapabilityDto,
  type IntegrationAuthorizationRequestDto,
  type IntegrationAuthorizationResponseDto,
} from '@agent-lens/protocol'
import { badRequest, readJsonBody, writeJson } from './http-utils'

const MAX_JSON_BODY_BYTES = 64 * 1024
const PRIVILEGED = new Set<IntegrationAuthorizationCapabilityDto>(['hook', 'runtime', 'live'])

export interface IntegrationAuthorizationController {
  grant(
    productId: string,
    capabilities: readonly IntegrationAuthorizationCapabilityDto[],
  ): Promise<readonly IntegrationAuthorizationCapabilityDto[]>
}

function requestPayload(value: unknown): IntegrationAuthorizationRequestDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be an object')
  }
  const capabilities = (value as Record<string, unknown>).capabilities
  if (!Array.isArray(capabilities) || !capabilities.every(item => typeof item === 'string')) {
    throw badRequest('capabilities must be an array of strings')
  }
  const normalized = [...new Set(capabilities)]
  if (!normalized.length) throw badRequest('capabilities must not be empty')
  if (normalized.some(item => !PRIVILEGED.has(item as IntegrationAuthorizationCapabilityDto))) {
    throw badRequest('capabilities may only contain hook, runtime or live')
  }
  return { capabilities: normalized as IntegrationAuthorizationCapabilityDto[] }
}

export async function handleIntegrationAuthorizationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  controller?: IntegrationAuthorizationController,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/authorization$/)
  if (!match) return false
  if (!controller) {
    writeJson(response, 503, { error: 'integration_authorization_unavailable' })
    return true
  }
  if (request.method !== 'PUT') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const productId = decodeURIComponent(match[1] ?? '').trim().toLowerCase()
  if (!productId) throw badRequest('productId is required')
  const payload = requestPayload(await readJsonBody(request, { maxBytes: MAX_JSON_BODY_BYTES }))
  const authorizedCapabilities = await controller.grant(productId, payload.capabilities)
  const body: IntegrationAuthorizationResponseDto = {
    productId,
    authorizedCapabilities: [...authorizedCapabilities],
    restartRequired: true,
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
    },
  }
  writeJson(response, 200, body)
  return true
}
