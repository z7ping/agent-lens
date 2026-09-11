import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type IntegrationEnabledStateDto,
  type IntegrationEnabledUpdateRequestDto,
  type IntegrationEnabledUpdateResponseDto,
  type IntegrationManagementResponseDto,
  type IntegrationPreferenceUpdateRequestDto,
  type IntegrationPreferencesDto,
  type IntegrationPreferencesResponseDto,
} from '@agent-lens/protocol'
import { badRequest, httpError, readJsonBody, writeJson } from './http-utils'

const MAX_JSON_BODY_BYTES = 64 * 1024

type IntegrationManagementState = Omit<IntegrationManagementResponseDto, 'meta'>
type IntegrationPreferencesState = IntegrationPreferencesDto

export interface IntegrationManagementController {
  query(): Promise<IntegrationManagementState>
  preferences(): IntegrationPreferencesState
  updatePreferences(
    request: IntegrationPreferenceUpdateRequestDto,
  ): Promise<IntegrationPreferencesState>
  enabled(integrationId: string): IntegrationEnabledStateDto | null
  setEnabled(
    integrationId: string,
    enabled: boolean,
  ): Promise<IntegrationEnabledStateDto>
}

function meta() {
  return {
    protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
  } as const
}

function enabledPayload(value: unknown): IntegrationEnabledUpdateRequestDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be an object')
  }
  const enabled = (value as Record<string, unknown>).enabled
  if (typeof enabled !== 'boolean') throw badRequest('enabled must be a boolean')
  return { enabled }
}

function preferencePayload(value: unknown): IntegrationPreferenceUpdateRequestDto {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Request body must be an object')
  }
  const input = value as Record<string, unknown>
  const result: IntegrationPreferenceUpdateRequestDto = {}

  if (input.onboardingCompleted !== undefined) {
    if (typeof input.onboardingCompleted !== 'boolean') {
      throw badRequest('onboardingCompleted must be a boolean')
    }
    result.onboardingCompleted = input.onboardingCompleted
  }

  for (const key of ['displayOrder', 'acknowledgedIntegrationIds'] as const) {
    const raw = input[key]
    if (raw === undefined) continue
    if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string')) {
      throw badRequest(`${key} must be an array of strings`)
    }
    result[key] = raw
  }

  if (
    result.onboardingCompleted === undefined
    && result.displayOrder === undefined
    && result.acknowledgedIntegrationIds === undefined
  ) {
    throw badRequest('At least one Integration preference field is required')
  }
  return result
}

function decodeIntegrationId(raw: string | undefined): string {
  const value = decodeURIComponent(raw ?? '').trim().toLowerCase()
  if (!value) throw badRequest('integrationId is required')
  return value
}

export async function handleIntegrationManagementRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  controller?: IntegrationManagementController,
): Promise<boolean> {
  const listRoute = url.pathname === '/api/v1/integrations'
  const preferencesRoute = url.pathname === '/api/v1/integrations/preferences'
  const enabledMatch = url.pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/enabled$/)
  if (!listRoute && !preferencesRoute && !enabledMatch) return false

  if (!controller) {
    writeJson(response, 503, { error: 'integration_management_unavailable' })
    return true
  }

  if (listRoute) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    const state = await controller.query()
    const body: IntegrationManagementResponseDto = { ...state, meta: meta() }
    writeJson(response, 200, body)
    return true
  }

  if (preferencesRoute) {
    if (request.method === 'GET') {
      const body: IntegrationPreferencesResponseDto = {
        preferences: controller.preferences(),
        meta: meta(),
      }
      writeJson(response, 200, body)
      return true
    }
    if (request.method !== 'PUT') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    const preferences = await controller.updatePreferences(
      preferencePayload(await readJsonBody(request, { maxBytes: MAX_JSON_BODY_BYTES })),
    )
    const body: IntegrationPreferencesResponseDto = { preferences, meta: meta() }
    writeJson(response, 200, body)
    return true
  }

  if (request.method !== 'PUT') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  const integrationId = decodeIntegrationId(enabledMatch?.[1])
  const current = controller.enabled(integrationId)
  if (!current) throw httpError(404, 'Unknown official Agent Integration')
  if (!current.editable) throw httpError(409, 'Integration Enabled state is managed by read-only runtime configuration')
  const payload = enabledPayload(await readJsonBody(request, { maxBytes: MAX_JSON_BODY_BYTES }))
  const enabled = await controller.setEnabled(integrationId, payload.enabled)
  const body: IntegrationEnabledUpdateResponseDto = {
    integrationId,
    enabled,
    meta: meta(),
  }
  writeJson(response, 200, body)
  return true
}

export const integrationManagementHttpInternals = {
  enabledPayload,
  preferencePayload,
  decodeIntegrationId,
}
