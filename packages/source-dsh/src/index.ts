import { basename } from 'node:path'
import type { DetectedSource, SourceDefinition, SourceExecutionContext } from '@agent-lens/core'
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'
import { dshManifest, dshSourceDefinition } from './source.js'

async function detectProfiledDsh(ctx: Parameters<SourceDefinition['detect']>[0]): Promise<DetectedSource[]> {
  const detected = await dshSourceDefinition.detect(ctx)
  return detected.map(item => {
    const profileRoot = item.dataRoot ?? item.configRoot
    if (!profileRoot) return item
    const nativeProfileId = basename(profileRoot) || 'default'
    const { configRoot, dataRoot, ...installationScoped } = item
    return {
      ...installationScoped,
      // DSH historically resolved one host/product Installation while each
      // profile owned its own roots. Preserve that stable Installation identity
      // across the Integration migration; profile paths belong exclusively to
      // RuntimeProfile and are overlaid back into the execution context below.
      runtimeProfile: {
        nativeProfileId,
        name: nativeProfileId,
        ...(configRoot ? { configRoot } : {}),
        ...(dataRoot ? { dataRoot } : {}),
      },
    }
  })
}

function profileContext<T extends SourceExecutionContext>(ctx: T): T {
  const profile = ctx.runtimeProfile
  if (!profile) return ctx
  return {
    ...ctx,
    installation: {
      ...ctx.installation,
      ...(profile.configRoot ? { configRoot: profile.configRoot } : {}),
      ...(profile.dataRoot ? { dataRoot: profile.dataRoot } : {}),
    },
  } as T
}

const profiledDshSourceDefinition: SourceDefinition = {
  ...dshSourceDefinition,
  detect: detectProfiledDsh,
  async *discoverAssets(ctx) {
    if (dshSourceDefinition.discoverAssets) yield* dshSourceDefinition.discoverAssets(profileContext(ctx))
  },
  async *ingestHistory(ctx) {
    if (dshSourceDefinition.ingestHistory) yield* dshSourceDefinition.ingestHistory(profileContext(ctx))
  },
  async startCapture(ctx, emitter) {
    return dshSourceDefinition.startCapture
      ? dshSourceDefinition.startCapture(profileContext(ctx), emitter)
      : { dispose() {} }
  },
}

const applyProfiledDshSource = Object.assign(
  (ctx: AgentLensContext) => {
    const registration = ctx.sources.register(profiledDshSourceDefinition)
    return () => registration.dispose()
  },
  { inject: ['sources'] },
)

export const profiledDshSourcePlugin = defineAgentLensPlugin(dshManifest, applyProfiledDshSource)

export const profiledDshSourceInternals = { detectProfiledDsh, profileContext }


export {
  dshManifest,
  dshSourceDefinition,
  discoverDshAssets,
  ingestDshHistory,
  normalizeDshRecord,
  parseDshJsonl,
  dshSourceInternals,
} from './source.js'
