import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { OFFICIAL_INTEGRATION_CATALOG } from '@agent-lens/integration-catalog'

export const INTEGRATION_PREFERENCES_VERSION = 1 as const

export interface IntegrationOnboardingPreference {
  completed: boolean
  completedAt?: string | undefined
}

export interface IntegrationPreferences {
  version: typeof INTEGRATION_PREFERENCES_VERSION
  onboarding: IntegrationOnboardingPreference
  displayOrder: string[]
  acknowledgedIntegrationIds: string[]
  updatedAt: string
}

export interface IntegrationPreferenceUpdate {
  onboardingCompleted?: boolean | undefined
  displayOrder?: readonly string[] | undefined
  acknowledgedIntegrationIds?: readonly string[] | undefined
}

function uniqueIds(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean))]
}

export function defaultIntegrationDisplayOrder(): string[] {
  return [...OFFICIAL_INTEGRATION_CATALOG]
    .sort((left, right) => left.defaultOrder - right.defaultOrder)
    .map(item => item.integrationId)
}

export function defaultIntegrationPreferences(): IntegrationPreferences {
  return {
    version: INTEGRATION_PREFERENCES_VERSION,
    onboarding: { completed: false },
    displayOrder: defaultIntegrationDisplayOrder(),
    acknowledgedIntegrationIds: [],
    updatedAt: new Date(0).toISOString(),
  }
}

function parseTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? value
    : undefined
}

function parseIntegrationPreferences(value: unknown): IntegrationPreferences | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.version !== INTEGRATION_PREFERENCES_VERSION) return null

  const onboarding = input.onboarding
  if (!onboarding || typeof onboarding !== 'object' || Array.isArray(onboarding)) return null
  const onboardingRecord = onboarding as Record<string, unknown>
  if (typeof onboardingRecord.completed !== 'boolean') return null

  if (!Array.isArray(input.displayOrder) || !Array.isArray(input.acknowledgedIntegrationIds)) return null

  const defaults = defaultIntegrationDisplayOrder()
  const configuredOrder = uniqueIds(input.displayOrder)
  const displayOrder = [
    ...configuredOrder,
    ...defaults.filter(id => !configuredOrder.includes(id)),
  ]
  const completedAt = parseTimestamp(onboardingRecord.completedAt)
  const updatedAt = parseTimestamp(input.updatedAt) ?? new Date(0).toISOString()

  return {
    version: INTEGRATION_PREFERENCES_VERSION,
    onboarding: {
      completed: onboardingRecord.completed,
      ...(onboardingRecord.completed && completedAt ? { completedAt } : {}),
    },
    displayOrder,
    acknowledgedIntegrationIds: uniqueIds(input.acknowledgedIntegrationIds),
    updatedAt,
  }
}

export function integrationPreferencesPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return env.AGENT_LENS_INTEGRATION_PREFERENCES_PATH
    || join(homedir(), '.agent-lens', '1.0', 'config', 'integration-preferences.json')
}

export function readIntegrationPreferencesSync(path: string): IntegrationPreferences | null {
  try {
    return parseIntegrationPreferences(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

async function persistIntegrationPreferences(
  path: string,
  preferences: IntegrationPreferences,
): Promise<void> {
  const parent = dirname(path)
  const temporaryPath = join(parent, `.integration-preferences-${process.pid}-${randomUUID()}.tmp`)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await writeFile(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, {
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
}

function clonePreferences(preferences: IntegrationPreferences): IntegrationPreferences {
  return {
    ...preferences,
    onboarding: { ...preferences.onboarding },
    displayOrder: [...preferences.displayOrder],
    acknowledgedIntegrationIds: [...preferences.acknowledgedIntegrationIds],
  }
}

export class IntegrationPreferenceService {
  private current: IntegrationPreferences
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    initial: IntegrationPreferences | null = readIntegrationPreferencesSync(path),
  ) {
    this.current = clonePreferences(initial ?? defaultIntegrationPreferences())
  }

  snapshot(): IntegrationPreferences {
    return clonePreferences(this.current)
  }

  update(request: IntegrationPreferenceUpdate): Promise<IntegrationPreferences> {
    const task = this.writeQueue.then(async () => {
      const current = this.current
      const onboardingCompleted = request.onboardingCompleted ?? current.onboarding.completed
      const displayOrder = request.displayOrder === undefined
        ? [...current.displayOrder]
        : uniqueIds(request.displayOrder)
      const defaults = defaultIntegrationDisplayOrder()
      const normalizedOrder = [
        ...displayOrder,
        ...defaults.filter(id => !displayOrder.includes(id)),
      ]
      const acknowledgedIntegrationIds = request.acknowledgedIntegrationIds === undefined
        ? [...current.acknowledgedIntegrationIds]
        : uniqueIds(request.acknowledgedIntegrationIds)
      const now = new Date().toISOString()
      const completedAt = onboardingCompleted
        ? current.onboarding.completedAt ?? now
        : undefined
      const next: IntegrationPreferences = {
        version: INTEGRATION_PREFERENCES_VERSION,
        onboarding: {
          completed: onboardingCompleted,
          ...(completedAt ? { completedAt } : {}),
        },
        displayOrder: normalizedOrder,
        acknowledgedIntegrationIds,
        updatedAt: now,
      }
      await persistIntegrationPreferences(this.path, next)
      this.current = next
      return this.snapshot()
    })
    this.writeQueue = task.then(() => undefined, () => undefined)
    return task
  }
}

export const integrationPreferenceInternals = {
  uniqueIds,
  parseIntegrationPreferences,
  persistIntegrationPreferences,
}
