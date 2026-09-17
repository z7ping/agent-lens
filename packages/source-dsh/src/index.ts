import { basename } from 'node:path'
import type { DetectedSource, SourceDefinition, SourceExecutionContext } from '@agent-lens/core'
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'
import { dshManifest, dshSourceDefinition, dshSourceInternals } from './source.js'

async function detectProfiledDsh(ctx: Parameters<SourceDefinition['detect']>[0]): Promise<DetectedSource[]> {
  const detected = await dshSourceDefinition.detect(ctx)
  const installationRoot = dshSourceInternals.dshHome(ctx.env ?? process.env)
  return detected.map(item => {
    const profileRoot = item.dataRoot ?? item.configRoot
    if (!profileRoot) return item
    const nativeProfileId = basename(profileRoot) || 'default'
    return {
      ...item,
      // Installation identity belongs to the DSH product root. Profile roots
      // remain on RuntimeProfile so multiple profiles never produce multiple
      // AgentInstallation identities.
      configRoot: installationRoot,
      dataRoot: installationRoot,
      runtimeProfile: {
        nativeProfileId,
        name: nativeProfileId,
        ...(item.configRoot ? { configRoot: item.configRoot } : {}),
        ...(item.dataRoot ? { dataRoot: item.dataRoot } : {}),
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

export const profiledDshSourceInternals = { detectProfiledDsh }


export {
  dshManifest,
  dshSourceDefinition,
  discoverDshAssets,
  ingestDshHistory,
  normalizeDshRecord,
  parseDshJsonl,
  dshSourceInternals,
} from './source.js'
