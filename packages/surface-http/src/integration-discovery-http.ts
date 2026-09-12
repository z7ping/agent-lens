import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AGENT_LENS_PROTOCOL_VERSION,
  type IntegrationToolDiscoveryResponseDto,
} from '@agent-lens/protocol'
import { writeJson } from './http-utils'

type IntegrationDiscoveryState = Omit<IntegrationToolDiscoveryResponseDto, 'meta'>

export interface IntegrationDiscoveryController {
  snapshot(): IntegrationDiscoveryState
  rescan(): Promise<IntegrationDiscoveryState>
}

function responseBody(state: IntegrationDiscoveryState): IntegrationToolDiscoveryResponseDto {
  return {
    ...state,
    meta: { protocolVersion: AGENT_LENS_PROTOCOL_VERSION },
  }
}

export async function handleIntegrationDiscoveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  controller?: IntegrationDiscoveryController,
): Promise<boolean> {
  const snapshotRoute = url.pathname === '/api/v1/integrations/discovery'
  const rescanRoute = url.pathname === '/api/v1/integrations/discovery/rescan'
  if (!snapshotRoute && !rescanRoute) return false

  if (!controller) {
    writeJson(response, 503, { error: 'integration_discovery_unavailable' })
    return true
  }

  if (snapshotRoute) {
    if (request.method !== 'GET') {
      writeJson(response, 405, { error: 'method_not_allowed' })
      return true
    }
    writeJson(response, 200, responseBody(controller.snapshot()))
    return true
  }

  if (request.method !== 'POST') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  writeJson(response, 200, responseBody(await controller.rescan()))
  return true
}
