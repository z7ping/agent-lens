import type { Plugin } from '@deepseek-ai/cordis'
import {
  DefaultAssetService,
  DefaultCapabilityService,
  DefaultCoverageService,
  DefaultEvidenceService,
  DefaultIdentityService,
  DefaultObservationService,
  DefaultSourceService,
  DefaultToolService,
} from '@agent-lens/core-services'
import type { AgentLensContext } from './context'
import { EventingAssetService } from './eventing-assets'
import { EventingObservationService } from './eventing-observations'
import {
  RuntimeProfileAssetService,
  RuntimeProfileObservationService,
} from './runtime-profile-services'

const applyCoreServices: Plugin.Function<void> = (ctx: AgentLensContext) => {
  const storage = ctx.storage
  const sources = new DefaultSourceService()
  const identity = new DefaultIdentityService(storage)
  const evidence = new DefaultEvidenceService(storage)
  const observations = new EventingObservationService(
    new RuntimeProfileObservationService(
      new DefaultObservationService(storage, identity),
      storage,
    ),
    ctx,
  )
  const coverage = new DefaultCoverageService(storage, evidence)
  const capabilities = new DefaultCapabilityService()
  const assets = new EventingAssetService(
    new RuntimeProfileAssetService(new DefaultAssetService(storage), storage),
    ctx,
  )
  const tools = new DefaultToolService(storage)

  ctx.provide('sources', sources)
  ctx.provide('identity', identity)
  ctx.provide('evidence', evidence)
  ctx.provide('observations', observations)
  ctx.provide('coverage', coverage)
  ctx.provide('capabilities', capabilities)
  ctx.provide('assets', assets)
  ctx.provide('tools', tools)
}

applyCoreServices.inject = ['storage']

/** Internal Cordis composition plugin; not part of the public AgentLens Plugin API. */
export const coreServicesPlugin = applyCoreServices
