import type { Server } from 'node:http'
import type { Disposable } from '@agent-lens/core'
import type { HttpStaticMount } from './static-files'

export const AGENT_LENS_HTTP_HOST = '127.0.0.1' as const
export const DEFAULT_AGENT_LENS_HTTP_PORT = 56789

/** Common HTTP lifecycle contract for the single native-only Daemon. */
export interface RunningHttpSurface {
  readonly host: typeof AGENT_LENS_HTTP_HOST
  readonly port: number
  readonly server: Server
  mountStatic(mount: HttpStaticMount): Disposable
  dispose(): Promise<void>
}
