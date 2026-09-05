import type { StorageService } from '@agent-lens/core'
import { HubReviewProjection } from '@agent-lens/projection-review'
import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'
import { HttpEventHub } from './events'
import {
  DEFAULT_AGENT_LENS_HTTP_PORT,
  startHttpSurface,
  type RunningHttpSurface,
} from './server'

declare module '@deepseek-ai/cordis' {
  interface Context {
    http: RunningHttpSurface
    hubReview: HubReviewProjection
  }
}

export interface HttpSurfacePluginConfig {
  port?: number
  /** Dynamic control/data-plane health contribution; must remain O(1). */
  dataRuntimeHealth?: () => Readonly<Record<string, unknown>> & { ok?: boolean }
}

const manifest = {
  pluginId: '@agent-lens/surface-http',
  pluginVersion: '1.0.0-alpha.2',
  apiVersion: '1.0',
  pluginType: 'surface',
  displayName: 'AgentLens HTTP Surface',
} as const

function storageWithRuntimeHealth(
  storage: StorageService,
  contributor: HttpSurfacePluginConfig['dataRuntimeHealth'],
): StorageService {
  if (!contributor) return storage
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'health') {
        return async () => {
          const health = await target.health()
          const dataRuntime = contributor()
          return {
            ...health,
            ok: health.ok && dataRuntime.ok !== false,
            details: {
              ...health.details,
              dataRuntime,
            },
          }
        }
      }
      const value = Reflect.get(target as object, property, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

const applyHttpSurface = Object.assign(
  async (ctx: AgentLensContext, config: HttpSurfacePluginConfig = {}) => {
    const eventHub = new HttpEventHub()
    const hubReview = new HubReviewProjection(
      ctx.unifiedRead.logicalSessions,
      ctx.unifiedRead.observations,
    )

    ctx.on('observation/committed', event => {
      void (async () => {
        const observation = await ctx.storage.repositories.observations.get(event.observationId)
        const sourceSession = observation
          ? await ctx.storage.repositories.sessions.getSourceSession(observation.sourceSessionId)
          : null
        eventHub.publish({
          type: 'observation.committed',
          observationId: event.observationId,
          ...(observation ? {
            logicalSessionId: observation.logicalSessionId,
            installationId: observation.installationId,
            ...(observation.projectId ? { projectId: observation.projectId } : {}),
          } : {}),
          ...(sourceSession ? { sourceId: sourceSession.sourceId } : {}),
          affected: ['review', 'sessions', 'usage', 'insights'],
          emittedAt: new Date().toISOString(),
        })
      })().catch(() => {
        eventHub.publish({
          type: 'observation.committed',
          observationId: event.observationId,
          affected: ['review', 'sessions', 'usage', 'insights'],
          emittedAt: new Date().toISOString(),
        })
      })
    })

    ctx.on('source/detected', event => {
      eventHub.publish({
        type: 'agent.changed',
        sourceId: event.sourceId,
        ...(event.installationId ? { installationId: event.installationId } : {}),
        affected: ['agents'],
        emittedAt: new Date().toISOString(),
      })
    })

    ctx.on('asset/changed', event => {
      eventHub.publish({
        type: 'agent.changed',
        assetBindingId: event.assetBindingId,
        affected: ['agents'],
        emittedAt: new Date().toISOString(),
      })
    })

    const surface = await startHttpSurface(storageWithRuntimeHealth(ctx.storage, config.dataRuntimeHealth), {
      port: config.port ?? DEFAULT_AGENT_LENS_HTTP_PORT,
      eventHub,
      sources: ctx.sources,
      capabilities: ctx.capabilities,
      capturePolicy: ctx.capturePolicy,
      backup: ctx.backup,
      piLive: ctx.piLive,
      hubReview,
    })
    const unprovideHubReview = ctx.provide('hubReview', hubReview)
    const unprovideHttp = ctx.provide('http', surface)
    return async () => {
      unprovideHttp()
      unprovideHubReview()
      eventHub.close()
      await surface.dispose()
    }
  },
  { inject: ['storage', 'unifiedRead', 'sources', 'capabilities', 'capturePolicy', 'backup', 'piLive'] },
)

export const httpSurfacePlugin = defineAgentLensPlugin(manifest, applyHttpSurface)

export const httpSurfacePluginInternals = {
  storageWithRuntimeHealth,
}
