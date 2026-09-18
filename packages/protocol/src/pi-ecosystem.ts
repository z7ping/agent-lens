import { AGENT_LENS_PROTOCOL_VERSION } from './timeline'

export type PiEcosystemResourceTypeDto = 'extension' | 'skill' | 'prompt' | 'theme'
export type PiEcosystemSortDto = 'downloads' | 'recent'

export interface PiEcosystemSearchRequestDto {
  query?: string | undefined
  type?: PiEcosystemResourceTypeDto | undefined
  sort?: PiEcosystemSortDto | undefined
  limit?: number | undefined
}

export interface PiEcosystemPackageDto {
  packageSource: string
  packageName: string
  version: string
  description?: string | undefined
  keywords: string[]
  resourceTypes: PiEcosystemResourceTypeDto[]
  monthlyDownloads?: number | undefined
  npmUrl: string
  officialUrl: string
  repositoryUrl?: string | undefined
  installCommand: string
  publishedAt?: string | undefined
}

export interface PiEcosystemSearchResponseDto {
  query: string
  type?: PiEcosystemResourceTypeDto | undefined
  sort: PiEcosystemSortDto
  items: PiEcosystemPackageDto[]
  upstreamTotal: number
  source: 'npm-registry'
  fetchedAt: string
  stale: boolean
  meta: {
    protocolVersion: typeof AGENT_LENS_PROTOCOL_VERSION
  }
}

export interface PiEcosystemPackageDetailsRequestDto {
  packageName: string
  version: string
}

export interface PiEcosystemPackageDetailsResponseDto {
  packageSource: string
  packageName: string
  version: string
  resourceTypes: PiEcosystemResourceTypeDto[]
  repositoryUrl?: string | undefined
}

/**
 * Read-only query contract implemented by the Pi Integration and consumed by a Surface.
 * Upstream ecosystem data is transient and never enters AgentLens canonical storage.
 */
export interface PiEcosystemQueryService {
  search(request?: PiEcosystemSearchRequestDto): Promise<PiEcosystemSearchResponseDto>
  packageDetails?(request: PiEcosystemPackageDetailsRequestDto): Promise<PiEcosystemPackageDetailsResponseDto>
}
