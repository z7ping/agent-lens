import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeEnabledSources } from './service'

export const CAPTURE_POLICY_CONFIGURATION_VERSION = 1 as const

export interface PersistedCapturePolicyConfiguration {
  version: typeof CAPTURE_POLICY_CONFIGURATION_VERSION
  enabledSources: string[]
  updatedAt: string
}

export function capturePolicyConfigurationPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.AGENT_LENS_CAPTURE_POLICY_PATH
    || join(homedir(), '.agent-lens', '1.0', 'config', 'capture-policy.json')
}

function parseConfiguration(value: unknown): PersistedCapturePolicyConfiguration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== CAPTURE_POLICY_CONFIGURATION_VERSION || !Array.isArray(input.enabledSources)) return null
  if (input.enabledSources.some(item => typeof item !== 'string')) return null
  return {
    version: CAPTURE_POLICY_CONFIGURATION_VERSION,
    enabledSources: normalizeEnabledSources(input.enabledSources),
    updatedAt: typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt))
      ? input.updatedAt
      : new Date(0).toISOString(),
  }
}

export function readCapturePolicyConfigurationSync(path: string): PersistedCapturePolicyConfiguration | null {
  try {
    return parseConfiguration(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export async function readCapturePolicyConfiguration(path: string): Promise<PersistedCapturePolicyConfiguration | null> {
  try {
    return parseConfiguration(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export async function writeCapturePolicyConfiguration(
  path: string,
  enabledSources: readonly string[],
): Promise<PersistedCapturePolicyConfiguration> {
  const configuration: PersistedCapturePolicyConfiguration = {
    version: CAPTURE_POLICY_CONFIGURATION_VERSION,
    enabledSources: normalizeEnabledSources(enabledSources),
    updatedAt: new Date().toISOString(),
  }
  const parent = dirname(path)
  const temporaryPath = join(parent, `.capture-policy-${process.pid}-${randomUUID()}.tmp`)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
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
  return configuration
}

export const capturePolicyConfigurationInternals = {
  parseConfiguration,
}
