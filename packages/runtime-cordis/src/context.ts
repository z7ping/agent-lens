import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type {
  AssetService,
  CapabilityService,
  CoreEventMap,
  CoverageService,
  EvidenceService,
  IdentityService,
  ObservationService,
  SourceService,
  StorageService,
  ToolService,
} from '@agent-lens/core'

declare module '@deepseek-ai/cordis' {
  interface Context {
    storage: StorageService
    sources: SourceService
    identity: IdentityService
    observations: ObservationService
    evidence: EvidenceService
    coverage: CoverageService
    capabilities: CapabilityService
    assets: AssetService
    tools: ToolService
  }

  interface Events {
    'source/registered'(event: CoreEventMap['source/registered']): void
    'source/detected'(event: CoreEventMap['source/detected']): void
    'source-record/received'(event: CoreEventMap['source-record/received']): void
    'observation/committed'(event: CoreEventMap['observation/committed']): void
    'coverage/changed'(event: CoreEventMap['coverage/changed']): void
    'asset/changed'(event: CoreEventMap['asset/changed']): void
    'projection/invalidated'(event: CoreEventMap['projection/invalidated']): void
    'projection/rebuilt'(event: CoreEventMap['projection/rebuilt']): void
  }
}

export type AgentLensContext = CordisContext
