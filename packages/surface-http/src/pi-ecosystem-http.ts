import type { IncomingMessage, ServerResponse } from 'node:http'
import type {
  PiEcosystemQueryService,
  PiEcosystemResourceTypeDto,
} from '@agent-lens/protocol'
import { writeJson } from './http-utils'

function resourceType(value: string | null): PiEcosystemResourceTypeDto | undefined {
  return value === 'extension' || value === 'skill' || value === 'prompt' || value === 'theme'
    ? value
    : undefined
}

function limitValue(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 20 ? parsed : undefined
}

export async function handlePiEcosystemRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service?: PiEcosystemQueryService,
): Promise<boolean> {
  if (url.pathname !== '/api/v1/integrations/pi/ecosystem') return false

  if (request.method !== 'GET') {
    writeJson(response, 405, { error: 'method_not_allowed' })
    return true
  }
  if (!service) {
    writeJson(response, 503, {
      error: 'pi_ecosystem_unavailable',
      message: 'Pi 生态发现当前不可用。',
    })
    return true
  }

  const rawType = url.searchParams.get('type')
  const rawLimit = url.searchParams.get('limit')
  const type = resourceType(rawType)
  const limit = limitValue(rawLimit)
  if (rawType && !type) {
    writeJson(response, 400, { error: 'invalid_pi_ecosystem_type' })
    return true
  }
  if (rawLimit && limit === undefined) {
    writeJson(response, 400, { error: 'invalid_pi_ecosystem_limit' })
    return true
  }

  try {
    const result = await service.search({
      query: url.searchParams.get('query')?.trim() ?? '',
      ...(type ? { type } : {}),
      ...(limit ? { limit } : {}),
    })
    writeJson(response, 200, result)
  } catch (error) {
    writeJson(response, 502, {
      error: 'pi_ecosystem_upstream_failed',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return true
}

export const piEcosystemHttpInternals = { resourceType, limitValue }
