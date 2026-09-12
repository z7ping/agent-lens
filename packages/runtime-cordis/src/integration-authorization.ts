import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentIntegrationCapability } from '@agent-lens/core'

export const INTEGRATION_AUTHORIZATION_VERSION = 1 as const

export type PrivilegedIntegrationCapability = Extract<
  AgentIntegrationCapability,
  'hook' | 'runtime' | 'live'
>

export interface IntegrationAuthorizationConfiguration {
  version: typeof INTEGRATION_AUTHORIZATION_VERSION
  grants: Record<string, PrivilegedIntegrationCapability[]>
  updatedAt: string
}

const PRIVILEGED = new Set<AgentIntegrationCapability>(['hook', 'runtime', 'live'])
const grantQueues = new Map<string, Promise<void>>()

function normalizeProductId(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeCapabilities(
  values: readonly AgentIntegrationCapability[],
): PrivilegedIntegrationCapability[] {
  return [...new Set(values.filter(
    (value): value is PrivilegedIntegrationCapability => PRIVILEGED.has(value),
  ))]
}

function emptyConfiguration(): IntegrationAuthorizationConfiguration {
  return {
    version: INTEGRATION_AUTHORIZATION_VERSION,
    grants: {},
    updatedAt: new Date(0).toISOString(),
  }
}

function parseConfiguration(value: unknown): IntegrationAuthorizationConfiguration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== INTEGRATION_AUTHORIZATION_VERSION) return null
  if (!input.grants || typeof input.grants !== 'object' || Array.isArray(input.grants)) return null

  const grants: Record<string, PrivilegedIntegrationCapability[]> = {}
  for (const [rawProductId, rawCapabilities] of Object.entries(input.grants as Record<string, unknown>)) {
    if (!Array.isArray(rawCapabilities) || rawCapabilities.some(value => typeof value !== 'string')) return null
    const productId = normalizeProductId(rawProductId)
    if (!productId) continue
    grants[productId] = normalizeCapabilities(rawCapabilities as AgentIntegrationCapability[])
  }

  return {
    version: INTEGRATION_AUTHORIZATION_VERSION,
    grants,
    updatedAt: typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt))
      ? input.updatedAt
      : new Date(0).toISOString(),
  }
}

export function integrationAuthorizationPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.AGENT_LENS_INTEGRATION_AUTH_PATH
    || join(homedir(), '.agent-lens', '1.0', 'config', 'integration-authorization.json')
}

export function readIntegrationAuthorizationSync(
  path: string,
): IntegrationAuthorizationConfiguration | null {
  try {
    return parseConfiguration(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export async function readIntegrationAuthorization(
  path: string,
): Promise<IntegrationAuthorizationConfiguration | null> {
  try {
    return parseConfiguration(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export function authorizedIntegrationCapabilities(
  configuration: IntegrationAuthorizationConfiguration | null,
  productId: string,
): PrivilegedIntegrationCapability[] {
  return configuration?.grants[normalizeProductId(productId)] ?? []
}

export function integrationAuthorizationBootstrap(
  configuration: IntegrationAuthorizationConfiguration | null,
  options: {
    legacyMigrationEligible: boolean
    selectedIntegrationIds: readonly string[]
  },
): Pick<IntegrationAuthorizationConfiguration, 'grants'> | null {
  if (configuration || !options.legacyMigrationEligible) return null
  const selected = new Set(options.selectedIntegrationIds.map(normalizeProductId))
  return {
    grants: {
      ...(selected.has('pi') ? { pi: ['runtime', 'live'] as PrivilegedIntegrationCapability[] } : {}),
      ...(selected.has('hermes') ? { hermes: ['live'] as PrivilegedIntegrationCapability[] } : {}),
    },
  }
}

export async function writeIntegrationAuthorization(
  path: string,
  configuration: Pick<IntegrationAuthorizationConfiguration, 'grants'>,
): Promise<IntegrationAuthorizationConfiguration> {
  const grants: Record<string, PrivilegedIntegrationCapability[]> = {}
  for (const [rawProductId, capabilities] of Object.entries(configuration.grants)) {
    const productId = normalizeProductId(rawProductId)
    if (!productId) continue
    grants[productId] = normalizeCapabilities(capabilities)
  }
  const normalized: IntegrationAuthorizationConfiguration = {
    version: INTEGRATION_AUTHORIZATION_VERSION,
    grants,
    updatedAt: new Date().toISOString(),
  }

  const parent = dirname(path)
  const temporaryPath = join(parent, `.integration-authorization-${process.pid}-${randomUUID()}.tmp`)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return normalized
}

export function grantIntegrationCapabilities(
  path: string,
  productId: string,
  capabilities: readonly AgentIntegrationCapability[],
): Promise<IntegrationAuthorizationConfiguration> {
  const id = normalizeProductId(productId)
  if (!id) return Promise.reject(new Error('Integration productId is required'))

  const previous = grantQueues.get(path) ?? Promise.resolve()
  const task = previous.catch(() => undefined).then(async () => {
    const current = await readIntegrationAuthorization(path) ?? emptyConfiguration()
    const merged = normalizeCapabilities([
      ...(current.grants[id] ?? []),
      ...capabilities,
    ])
    return writeIntegrationAuthorization(path, {
      grants: {
        ...current.grants,
        [id]: merged,
      },
    })
  })
  const queued = task.then(() => undefined, () => undefined)
  grantQueues.set(path, queued)
  void queued.finally(() => {
    if (grantQueues.get(path) === queued) grantQueues.delete(path)
  })
  return task
}

export const integrationAuthorizationInternals = {
  normalizeProductId,
  normalizeCapabilities,
  parseConfiguration,
}
