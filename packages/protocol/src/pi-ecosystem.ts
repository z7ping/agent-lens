import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type PiEcosystemResourceTypeDto = 'extension' | 'skill' | 'prompt' | 'theme'

export interface PiEcosystemSearchRequestDto {
  query?: string | undefined
  type?: PiEcosystemResourceTypeDto | undefined
  limit?: number | undefined
}

export interface PiEcosystemPackageDto {
  packageSource: string
  packageName: string
  version: string
  description?: string | undefined
  keywords: string[]
  resourceTypes: PiEcosystemResourceTypeDto[]
  npmUrl: string
  officialUrl: string
  repositoryUrl?: string | undefined
  installCommand: string
  publishedAt?: string | undefined
}

export interface PiEcosystemSearchResponseDto {
  query: string
  type?: PiEcosystemResourceTypeDto | undefined
  items: PiEcosystemPackageDto[]
  upstreamTotal: number
  source: 'npm-registry'
  fetchedAt: string
  stale: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}

/**
 * Read-only query contract implemented by the Pi Integration and consumed by a Surface.
 * Upstream ecosystem data is transient and never enters AgentLens canonical storage.
 */
export interface PiEcosystemQueryService {
  search(request?: PiEcosystemSearchRequestDto): Promise<PiEcosystemSearchResponseDto>
}
