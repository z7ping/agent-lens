import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type IntegrationPackageCatalogItemDto,
  type IntegrationPackageCatalogResponseDto,
  type IntegrationPackageOperationDto,
  type IntegrationPackageOperationResponseDto,
  type IntegrationPackageStateDto,
  type IntegrationPackageStateResponseDto,
} from '@agent-lens/protocol'
import { badRequest, writeJson } from './http-utils'

export interface IntegrationPackageController {
  catalog(): IntegrationPackageCatalogItemDto[]
  states(): IntegrationPackageStateDto[]
  state(integrationId: string): IntegrationPackageStateDto | null
  install(integrationId: string): Promise<IntegrationPackageOperationDto>
  remove(integrationId: string): Promise<IntegrationPackageOperationDto>
  update(integrationId: string): Promise<IntegrationPackageOperationDto>
  operation(operationId: string): IntegrationPackageOperationDto | null
}

function meta() {
  return {
    protocolVersion: AGENT_LENS_PROTOCOL_VERSION,
    generatedAt: new Date().toISOString(),
  } as const
}

function decodeId(raw: string | undefined, label: string): string {
  let value = ''
  try {
    value = decodeURIComponent(raw ?? '').trim().toLowerCase()
  } catch {
    throw badRequest(`${label} is not valid URL encoding`)
  }
  if (!value) throw badRequest(`${label} is required`)
  return value
}

function publicState(state: IntegrationPackageStateDto): IntegrationPackageStateDto {
  return {
    integrationId: state.integrationId,
    installed: state.installed,
    ...(state.installedVersion ? { installedVersion: state.installedVersion } : {}),
    ...(state.availableVersion ? { availableVersion: state.availableVersion } : {}),
    compatibility: state.compatibility,
    integrity: state.integrity,
    restartRequired: state.restartRequired,
    ...(state.reason ? { reason: state.reason } : {}),
  }
}

function operationResponse(
  controller: IntegrationPackageController,
  operation: IntegrationPackageOperationDto,
): IntegrationPackageOperationResponseDto {
  const state = controller.state(operation.integrationId)
  if (!state) throw new Error(`Integration package state disappeared: ${operation.integrationId}`)
  return { operation, state: publicState(state), meta: meta() }
}

export async function handleIntegrationPackageRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  controller?: IntegrationPackageController,
): Promise<boolean> {
  const catalogRoute = url.pathname === '/api/v1/integrations/catalog'
  const operationMatch = url.pathname.match(/^\/api\/v1\/integration-operations\/([^/]+)$/)
  const packageStateMatch = url.pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/package$/)
  const installMatch = url.pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/install$/)
  const updateMatch = url.pathname.match(/^\/api\/v1\/integrations\/([^/]+)\/update$/)
  const removeMatch = url.pathname.match(/^\/api\/v1\/integrations\/([^/]+)$/)

  if (
    !catalogRoute
    && !operationMatch
    && !packageStateMatch
    && !installMatch
    && !updateMatch
    && !removeMatch
  ) return false

  if (!controller) {
    writeJson(response, 503, { error: 'integration_package_lifecycle_unavailable' })
    return true
  }

  if (catalogRoute) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    const body: IntegrationPackageCatalogResponseDto = {
      catalog: controller.catalog(),
      states: controller.states().map(publicState),
      meta: meta(),
    }
    writeJson(response, 200, body)
    return true
  }

  if (operationMatch) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    const operationId = decodeId(operationMatch[1], 'operationId')
    const operation = controller.operation(operationId)
    if (!operation) {
      writeJson(response, 404, { error: 'integration_operation_not_found' })
      return true
    }
    writeJson(response, 200, operationResponse(controller, operation))
    return true
  }

  const rawIntegrationId =
    packageStateMatch?.[1]
    ?? installMatch?.[1]
    ?? updateMatch?.[1]
    ?? removeMatch?.[1]
  const integrationId = decodeId(rawIntegrationId, 'integrationId')
  const state = controller.state(integrationId)
  if (!state) {
    writeJson(response, 404, { error: 'integration_not_found' })
    return true
  }

  if (packageStateMatch) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    const body: IntegrationPackageStateResponseDto = { state: publicState(state), meta: meta() }
    writeJson(response, 200, body)
    return true
  }

  if (installMatch) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    writeJson(response, 200, operationResponse(controller, await controller.install(integrationId)))
    return true
  }

  if (updateMatch) {
    if (request.method !== 'POST') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    writeJson(response, 200, operationResponse(controller, await controller.update(integrationId)))
    return true
  }

  if (request.method !== 'DELETE') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  writeJson(response, 200, operationResponse(controller, await controller.remove(integrationId)))
  return true
}
