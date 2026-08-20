import type {
  AgentLensPluginManifest,
  CoreEventMap,
  StorageService,
} from '@agent-lens/core'
import { HttpEventHub } from './events'
import {
  DEFAULT_AGENT_LENS_HTTP_PORT,
  startHttpSurface,
} from './server'

export interface HttpSurfacePluginConfig {
  port?: number
  staticDir?: string
}

export interface HttpSurfaceRuntime {
  readonly storage: StorageService
  onObservationCommitted(
    listener: (event: CoreEventMap['observation/committed']) => void,
  ): void
}

export const httpSurfaceManifest = {
  pluginId: '@agent-lens/surface-http',
  pluginVersion: '1.0.0-alpha.0',
  apiVersion: '1.0',
  pluginType: 'surface',
  displayName: 'AgentLens HTTP Surface',
} as const satisfies AgentLensPluginManifest

export async function createHttpSurface(
  runtime: HttpSurfaceRuntime,
  config: HttpSurfacePluginConfig = {},
) {
  const eventHub = new HttpEventHub()
  runtime.onObservationCommitted(event => {
    eventHub.publish({
      type: 'observation.committed',
      observationId: event.observationId,
      emittedAt: new Date().toISOString(),
    })
  })

  return startHttpSurface(runtime.storage, {
    port: config.port ?? DEFAULT_AGENT_LENS_HTTP_PORT,
    ...(config.staticDir ? { staticDir: config.staticDir } : {}),
    eventHub,
  })
}
