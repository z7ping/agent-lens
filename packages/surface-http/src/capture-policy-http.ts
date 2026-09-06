import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapturePolicyService } from '@agent-lens/core'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type CapturePolicyResponseDto,
  type CapturePolicySourceUpdateRequestDto,
} from '@agent-lens/protocol'
import { badRequest, readJsonBody, writeJson } from './http-utils'

const MAX_JSON_BODY_BYTES = 1024 * 1024

function capturePolicyResponse(capturePolicy: CapturePolicyService): CapturePolicyResponseDto {
  const configuration = capturePolicy.getSourceConfiguration()
  return {
    settings: {
      effectiveEnabledSources: [...configuration.effectiveEnabledSources],
      configuredEnabledSources: [...configuration.configuredEnabledSources],
      managedBy: configuration.source,
      editable: configuration.editable,
      restartRequired: configuration.restartRequired,
    },
    meta: {
      protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
      generatedAt: new Date().toISOString(),
    },
  }
}

function capturePolicyUpdatePayload(value: unknown): CapturePolicySourceUpdateRequestDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be an object')
  }
  const enabledSources = (value as Record<string, unknown>).enabledSources
  if (!Array.isArray(enabledSources) || !enabledSources.every(item => typeof item === 'string')) {
    throw badRequest('enabledSources must be an array of strings')
  }
  const normalized = enabledSources.map(value => value.trim()).filter(Boolean)
  if (!normalized.length) throw badRequest('enabledSources must contain at least one source')
  return { enabledSources: normalized }
}

export async function handleCapturePolicyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  capturePolicy?: CapturePolicyService,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/capture-policy/sources') return false
  if (!capturePolicy) {
    writeJson(response, 503, { error: 'capture_policy_unavailable' })
    return true
  }

  if (request.method === 'GET') {
    writeJson(response, 200, capturePolicyResponse(capturePolicy))
    return true
  }

  if (request.method !== 'PUT') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }

  const payload = capturePolicyUpdatePayload(await readJsonBody(request, { maxBytes: MAX_JSON_BODY_BYTES }))
  await capturePolicy.setEnabledSources(payload.enabledSources)
  writeJson(response, 200, capturePolicyResponse(capturePolicy))
  return true
}

export const capturePolicyHttpInternals = {
  capturePolicyResponse,
  capturePolicyUpdatePayload,
}
