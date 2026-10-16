import { access } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  OFFICIAL_INTEGRATION_CATALOG,
  resolveToolDiscoveryRoots,
  type OfficialIntegrationCatalogEntry,
} from '@agent-lens/integration-catalog'
import {
  resolveExecutable,
  resolveLoginShellPath,
  resolveWindowsNpmShimTarget,
  type ExecutableDiscoveryOptions,
} from './executable-discovery'

const execFileAsync = promisify(execFile)

/** Read a CLI version from the executable actually discovered on the host. */
export async function probeAgentCliVersion(
  executable: string,
  options: { platform?: NodeJS.Platform; timeoutMs?: number; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform
  const timeoutMs = Math.min(options.timeoutMs ?? 10_000, 15_000)
  let command = executable
  let args = ['--version']
  if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    // Do not use shell:true for paths that could contain cmd metacharacters.
    // An npm shim resolves to a JS entry and can run safely using Node directly.
    const entry = await resolveWindowsNpmShimTarget(executable)
    if (!entry) return undefined
    if (/\.exe$/i.test(entry)) {
      command = entry
    } else {
      const node = await resolveExecutable('node', { platform, pathValue: options.env?.PATH })
      if (!node) return undefined
      command = node
      args = [entry, '--version']
    }
  }
  try {
    const result = await execFileAsync(command, args, {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 16 * 1024,
      encoding: 'utf8',
      env: options.env ? { ...process.env, ...options.env } : process.env,
    })
    // Ignore diagnostics and arbitrary numbers; only a semantic CLI version is evidence.
    const text = `${result.stdout}\n${result.stderr}`
    return text.match(/(?:^|[^\w.])v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=$|[^\w.])/m)?.[1]
  } catch {
    return undefined
  }
}

export type ToolPresence = 'present' | 'data-only' | 'absent' | 'error'
export type ToolDiscoveryScanStatus = 'idle' | 'scanning' | 'complete'

export interface OfficialToolDiscoveryItem {
  integrationId: string
  productId: string
  displayName: string
  presence: ToolPresence
  executable?: string | undefined
  version?: string | undefined
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
  versionTimeoutMs?: number | undefined
  shellPathResolver?: (() => Promise<string | undefined>) | undefined
  versionResolver?: ((executable: string) => Promise<string | undefined>) | undefined
  executableResolver?: ((
    name: string,
    options?: ExecutableDiscoveryOptions,
  ) => Promise<string | undefined>) | undefined
}

interface RootProbe {
  role: 'config' | 'data'
  path: string
  exists: boolean
  error?: string | undefined
}

const DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS = 2_500

function errorMessage(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
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
    versionTimeoutMs: number
    env: Readonly<Record<string, string | undefined>>
    shellPathResolver: () => Promise<string | undefined>
    executableResolver: NonNullable<OfficialToolDiscoveryOptions['executableResolver']>
    versionResolver: NonNullable<OfficialToolDiscoveryOptions['versionResolver']>
  },
): Promise<OfficialToolDiscoveryItem> {
  try {
    const executableDescriptor = entry.discovery.executable
    const executableProbe = (async (): Promise<{ executable?: string; errors: string[] }> => {
      if (!executableDescriptor) return { errors: [] }
      const errors: string[] = []
      for (const command of executableDescriptor.commands) {
        try {
          const executable = await options.executableResolver(command, {
            explicit: executableDescriptor.explicitEnvVar
              ? options.env[executableDescriptor.explicitEnvVar]
              : undefined,
            platform: options.platform,
            pathValue: options.env.PATH,
            shellPathResolver: options.shellPathResolver,
          })
          if (executable) return { executable, errors }
        } catch (error) {
          errors.push(errorMessage(error))
        }
      }
      return { errors }
    })()

    const roots = resolveToolDiscoveryRoots(entry, {
      env: options.env,
      platform: options.platform,
      homeDir: options.homeDir,
    })
    const [executableResult, probes] = await Promise.all([
      executableProbe,
      Promise.all(roots.map(probeRoot)),
    ])
    const executable = executableResult.executable
    const version = executable
      ? await timeout(options.versionResolver(executable), options.versionTimeoutMs, 'CLI version').catch(() => undefined)
      : undefined
    const configRoot = probes.find(item => item.role === 'config' && item.exists)?.path
    const dataRoot = probes.find(item => item.role === 'data' && item.exists)?.path
    const errors = [
      ...executableResult.errors,
      ...probes.flatMap(item => item.error ? [item.error] : []),
    ]

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
      ...(version ? { version } : {}),
      ...(configRoot ? { configRoot } : {}),
      ...(dataRoot ? { dataRoot } : {}),
      ...(presence === 'error' && errors.length ? { reason: errors[0] } : {}),
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
  integrationId?: string,
): Promise<OfficialToolDiscoveryItem[]> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const homeDir = options.homeDir ?? homedir()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS
  const versionTimeoutMs = options.versionTimeoutMs ?? 10_000
  const executableResolver = options.executableResolver ?? resolveExecutable
  const versionResolver = options.versionResolver ?? (executable => probeAgentCliVersion(executable, { platform, timeoutMs: versionTimeoutMs, env }))
  let shellPathPromise: Promise<string | undefined> | undefined
  const sourceShellPathResolver = options.shellPathResolver ?? (() => resolveLoginShellPath(platform))
  const shellPathResolver = () => {
    shellPathPromise ??= Promise.resolve(sourceShellPathResolver())
    return shellPathPromise
  }

  const entries = integrationId
    ? OFFICIAL_INTEGRATION_CATALOG.filter(entry => entry.integrationId === integrationId)
    : OFFICIAL_INTEGRATION_CATALOG

  return Promise.all(entries.map(entry =>
    timeout(
      discoverEntry(entry, { env, platform, homeDir, timeoutMs, versionTimeoutMs, shellPathResolver, executableResolver, versionResolver }),
      timeoutMs + versionTimeoutMs + 3_000,
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
  private inFlight: { requestedIntegrationId?: string; promise: Promise<OfficialToolDiscoverySnapshot> } | null = null

  constructor(private readonly options: OfficialToolDiscoveryOptions = {}) {}

  snapshot(): OfficialToolDiscoverySnapshot {
    return cloneSnapshot(this.current)
  }

  rescan(integrationId?: string): Promise<OfficialToolDiscoverySnapshot> {
    if (this.inFlight) {
      if (this.inFlight.requestedIntegrationId === integrationId) return this.inFlight.promise
      return this.inFlight.promise.then(() => this.rescan(integrationId))
    }

    const scopedIntegrationId = integrationId && this.current.status === 'complete'
      ? integrationId
      : undefined
    const previousItems = this.current.items
    const startedAt = new Date().toISOString()
    this.current = {
      ...this.current,
      status: 'scanning',
      startedAt,
      generatedAt: startedAt,
    }

    const promise = discoverOfficialTools(this.options, scopedIntegrationId)
      .then(items => {
        const completedAt = new Date().toISOString()
        const refreshed = new Map(items.map(item => [item.integrationId, item]))
        const mergedItems = scopedIntegrationId
          ? [
              ...previousItems.map(item => refreshed.get(item.integrationId) ?? item),
              ...items.filter(item => !previousItems.some(previous => previous.integrationId === item.integrationId)),
            ]
          : items
        this.current = {
          status: 'complete',
          items: mergedItems,
          startedAt,
          completedAt,
          generatedAt: completedAt,
        }
        return this.snapshot()
      })
      .finally(() => {
        if (this.inFlight?.promise === promise) this.inFlight = null
      })

    this.inFlight = { ...(integrationId ? { requestedIntegrationId: integrationId } : {}), promise }
    return promise
  }
}

export const toolDiscoveryInternals = {
  pathExists,
  probeRoot,
  errorMessage,
  DEFAULT_TOOL_DISCOVERY_TIMEOUT_MS,
}
