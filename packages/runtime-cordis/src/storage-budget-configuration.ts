import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  isStorageBudgetPolicy,
  storageBudgetPreset,
  type StorageBudgetPolicy,
  type StorageBudgetPreset,
} from '@agent-lens/core'

export interface PersistedStorageBudgetConfiguration {
  policy: StorageBudgetPolicy
  updatedAt: string
}

export function storageBudgetConfigurationPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.AGENT_LENS_STORAGE_BUDGET_PATH
    || join(homedir(), '.agent-lens', '1.0', 'config', 'storage-budget.json')
}

function parseConfiguration(value: unknown): PersistedStorageBudgetConfiguration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (!isStorageBudgetPolicy(input.policy)) return null
  return {
    policy: input.policy,
    updatedAt: typeof input.updatedAt === 'string' && Number.isFinite(Date.parse(input.updatedAt))
      ? input.updatedAt
      : new Date(0).toISOString(),
  }
}

export function readStorageBudgetConfigurationSync(path: string): PersistedStorageBudgetConfiguration | null {
  try {
    return parseConfiguration(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export async function readStorageBudgetConfiguration(path: string): Promise<PersistedStorageBudgetConfiguration | null> {
  try {
    return parseConfiguration(JSON.parse(await readFile(path, 'utf8')))
  } catch {
    return null
  }
}

export async function writeStorageBudgetConfiguration(
  path: string,
  policy: StorageBudgetPolicy,
): Promise<PersistedStorageBudgetConfiguration> {
  if (!isStorageBudgetPolicy(policy)) throw new TypeError('Storage budget policy is invalid')
  const configuration: PersistedStorageBudgetConfiguration = {
    policy,
    updatedAt: new Date().toISOString(),
  }
  const parent = dirname(path)
  const temporaryPath = join(parent, `.storage-budget-${process.pid}-${randomUUID()}.tmp`)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  })
  try {
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
  return configuration
}

export function resolveStorageBudgetPolicy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { policy: StorageBudgetPolicy, source: 'file' | 'default', path: string } {
  const path = storageBudgetConfigurationPath(env)
  const persisted = readStorageBudgetConfigurationSync(path)
  return persisted
    ? { policy: persisted.policy, source: 'file', path }
    : { policy: storageBudgetPreset(), source: 'default', path }
}

export function storageBudgetPresetPolicy(preset: StorageBudgetPreset): StorageBudgetPolicy {
  return storageBudgetPreset(preset)
}
