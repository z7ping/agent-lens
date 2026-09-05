import { monitorEventLoopDelay } from 'node:perf_hooks'
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

function errorSummary(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 1000)
}

function milliseconds(nanoseconds: number): number {
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) return 0
  return nanoseconds / 1_000_000
}

function eventLoopSnapshot(histogram: ReturnType<typeof monitorEventLoopDelay>) {
  return {
    resolutionMs: 20,
    minMs: milliseconds(histogram.min),
    maxMs: milliseconds(histogram.max),
    meanMs: milliseconds(histogram.mean),
    p50Ms: milliseconds(histogram.percentile(50)),
    p95Ms: milliseconds(histogram.percentile(95)),
    p99Ms: milliseconds(histogram.percentile(99)),
  }
}

function storageWithRuntimeHealth(
  storage: StorageService,
  contributor: HttpSurfacePluginConfig['dataRuntimeHealth'],
  eventLoopHealth?: () => Readonly<Record<string, unknown>>,
): StorageService {
  if (!contributor && !eventLoopHealth) return storage
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === 'health') {
        return async () => {
          const dataRuntime = contributor?.()
          const eventLoop = eventLoopHealth?.()
          try {
            const health = await target.health()
            return {
              ...health,
              ok: health.ok && dataRuntime?.ok !== false,
              details: {
                ...health.details,
                ...(dataRuntime ? { dataRuntime } : {}),
                ...(eventLoop ? { eventLoop } : {}),
              },
            }
          } catch (error) {
            return {
              ok: false,
              details: {
                ...(dataRuntime ? { dataRuntime } : {}),
                ...(eventLoop ? { eventLoop } : {}),
                storageUnavailable: true,
                storageError: errorSummary(error),
              },
            }
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
    const eventLoop = monitorEventLoopDelay({ resolution: 20 })
    eventLoop.enable()
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

    const healthStorage = storageWithRuntimeHealth(
      ctx.storage,
      config.dataRuntimeHealth,
      () => eventLoopSnapshot(eventLoop),
    )
    const surface = await startHttpSurface(healthStorage, {
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
      eventLoop.disable()
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
  milliseconds,
  eventLoopSnapshot,
}
