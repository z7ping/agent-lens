import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type {
  AssetService,
  BackupService,
  CapabilityService,
  CapturePolicyService,
  CoreEventMap,
  CoverageService,
  EvidenceService,
  IdentityService,
  ObservationService,
  ProjectionService,
  SourceService,
  StorageService,
  ToolService,
} from '@agent-lens/core'
import type { AgentLensNodeRuntime } from './node-identity'

declare module '@deepseek-ai/cordis' {
  interface Context {
    node: AgentLensNodeRuntime
    storage: StorageService
    sources: SourceService
    identity: IdentityService
    observations: ObservationService
    evidence: EvidenceService
    coverage: CoverageService
    capabilities: CapabilityService
    assets: AssetService
    tools: ToolService
    projections: ProjectionService
    backup: BackupService
    capturePolicy: CapturePolicyService
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
