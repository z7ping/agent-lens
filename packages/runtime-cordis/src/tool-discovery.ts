import { access } from 'node:fs/promises'
import { join } from 'node:path'
import {
  OFFICIAL_INTEGRATION_CATALOG,
  resolveToolDiscoveryRoots,
  type OfficialIntegrationCatalogEntry,
} from '@agent-lens/integration-catalog'
import {
  resolveExecutable,
  resolveLoginShellPath,
} from './executable-discovery'

export type ToolPresence = 'present' | 'data-only' | 'absent' | 'error'
export type ToolDiscoveryScanStatus = 'idle' | 'scanning' | 'complete'

export interface OfficialToolDiscoveryItem {
  integrationId: string
  productId: string
  displayName: string
  presence: ToolPresence
  executable?: string | undefined
  configRoot?: string | undefined
  dataRoot?: string | undefined
  reason?: string | undefined
}

export interface OfficialToolDiscoverySnapshot {
  status: ToolDiscoveryScanStatus
  items: OfficialToolDiscoveryItem[]
  startedAt?: string | undefined
  completedAt?: string | undefined
  generatedAt: string
}

export interface OfficialToolDiscoveryOptions {
  env?: Readonly<Record<string, string | undefined>> | undefined
  platform?: NodeJS.Platform | undefined
  homeDir?: string | undefined
  timeoutMs?: number | undefined
}

interface RootProbe {
  role: 'config' | 'data'
  path: string
  exists: boolean
  error?: string | undefined
}

const DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS = 2_500

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_-]?key|token|authorization|password)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 800)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function probeRoot(
  root: ReturnType<typeof resolveToolDiscoveryRoots>[number],
): Promise<RootProbe> {
  const probePath = root.marker ? join(root.path, root.marker) : root.path
  try {
    return {
      role: root.role,
      path: root.path,
      exists: await pathExists(probePath),
    }
  } catch (error) {
    return {
      role: root.role,
      path: root.path,
      exists: false,
      error: errorMessage(error),
    }
  }
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
    promise.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function discoverEntry(
  entry: OfficialIntegrationCatalogEntry,
  options: Required<Pick<OfficialToolDiscoveryOptions, 'platform' | 'homeDir' | 'timeoutMs'>> & {
    env: Readonly<Record<string, string | undefined>>
    shellPathResolver: () => Promise<string | undefined>
  },
): Promise<OfficialToolDiscoveryItem> {
  try {
    const executableDescriptor = entry.discovery.executable
    let executable: string | undefined
    if (executableDescriptor) {
      for (const command of executableDescriptor.commands) {
        executable = await resolveExecutable(command, {
          explicit: executableDescriptor.explicitEnvVar
            ? options.env[executableDescriptor.explicitEnvVar]
            : undefined,
          platform: options.platform,
          pathValue: options.env.PATH,
          shellPathResolver: options.shellPathResolver,
        })
        if (executable) break
      }
    }

    const roots = resolveToolDiscoveryRoots(entry, {
      env: options.env,
      platform: options.platform,
      homeDir: options.homeDir,
    })
    const probes = await Promise.all(roots.map(probeRoot))
    const configRoot = probes.find(item => item.role === 'config' && item.exists)?.path
    const dataRoot = probes.find(item => item.role === 'data' && item.exists)?.path
    const errors = probes.flatMap(item => item.error ? [item.error] : [])

    const presence: ToolPresence = executable
      ? 'present'
      : configRoot || dataRoot
        ? 'data-only'
        : errors.length
          ? 'error'
          : 'absent'

    return {
      integrationId: entry.integrationId,
      productId: entry.productId,
      displayName: entry.displayName,
      presence,
      ...(executable ? { executable } : {}),
      ...(configRoot ? { configRoot } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      ...(errors.length ? { reason: errors[0] } : {}),
    }
  } catch (error) {
    return {
      integrationId: entry.integrationId,
      productId: entry.productId,
      displayName: entry.displayName,
      presence: 'error',
      reason: errorMessage(error),
    }
  }
}

export async function discoverOfficialTools(
  options: OfficialToolDiscoveryOptions = {},
): Promise<OfficialToolDiscoveryItem[]> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? (await import('node:os')).homedir()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS
  let shellPathPromise: Promise<string | undefined> | undefined
  const shellPathResolver = () => {
    shellPathPromise ??= resolveLoginShellPath(platform)
    return shellPathPromise
  }

  return Promise.all(OFFICIAL_INTEGRATION_CATALOG.map(entry =>
    timeout(
      discoverEntry(entry, { env, platform, homeDir, timeoutMs, shellPathResolver }),
      timeoutMs,
      `Tool discovery for ${entry.integrationId}`,
    ).catch(error => ({
      integrationId: entry.integrationId,
      productId: entry.productId,
      displayName: entry.displayName,
      presence: 'error' as const,
      reason: errorMessage(error),
    })),
  ))
}

function cloneSnapshot(snapshot: OfficialToolDiscoverySnapshot): OfficialToolDiscoverySnapshot {
  return {
    ...snapshot,
    items: snapshot.items.map(item => ({ ...item })),
  }
}

export class OfficialToolDiscoveryService {
  private current: OfficialToolDiscoverySnapshot = {
    status: 'idle',
    items: [],
    generatedAt: new Date().toISOString(),
  }
  private inFlight: Promise<OfficialToolDiscoverySnapshot> | null = null

  constructor(private readonly options: OfficialToolDiscoveryOptions = {}) {}

  snapshot(): OfficialToolDiscoverySnapshot {
    return cloneSnapshot(this.current)
  }

  rescan(): Promise<OfficialToolDiscoverySnapshot> {
    if (this.inFlight) return this.inFlight

    const startedAt = new Date().toISOString()
    this.current = {
      ...this.current,
      status: 'scanning',
      startedAt,
      generatedAt: startedAt,
    }

    const task = discoverOfficialTools(this.options)
      .then(items => {
        const completedAt = new Date().toISOString()
        this.current = {
          status: 'complete',
          items,
          startedAt,
          completedAt,
          generatedAt: completedAt,
        }
        return this.snapshot()
      })
      .finally(() => {
        if (this.inFlight === task) this.inFlight = null
      })

    this.inFlight = task
    return task
  }
}

export const toolDiscoveryInternals = {
  pathExists,
  probeRoot,
  errorMessage,
  DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS,
}
