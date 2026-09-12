import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  OFFICIAL_INTEGRATION_CATALOG,
  officialIntegrationCatalogEntry,
} from '@agent-lens/integration-catalog'

export const INTEGRATION_PREFERENCES_VERSION = 1 as const

export interface IntegrationOnboardingPreference {
  completed: boolean
  completedAt?: string | undefined
}

export interface IntegrationPreferences {
  version: typeof INTEGRATION_PREFERENCES_VERSION
  onboarding: IntegrationOnboardingPreference
  displayOrder: string[]
  displayOrderConfigured: boolean
  acknowledgedIntegrationIds: string[]
  updatedAt: string
}

export interface IntegrationPreferenceUpdate {
  onboardingCompleted?: true | undefined
  displayOrder?: readonly string[] | undefined
  acknowledgedIntegrationIds?: readonly string[] | undefined
}

const EPOCH = new Date(0).toISOString()

function normalizedOfficialIds(values: readonly unknown[]): string[] {
  return [...new Set(values
    .filter((value): value is string => typeof value === 'string')
    .map(value => value.trim().toLowerCase())
    .filter(value => Boolean(value) && Boolean(officialIntegrationCatalogEntry(value))))]
}

export function defaultIntegrationDisplayOrder(): string[] {
  return [...OFFICIAL_INTEGRATION_CATALOG]
    .sort((left, right) => left.defaultOrder - right.defaultOrder)
    .map(item => item.integrationId)
}

function effectiveDisplayOrder(values: readonly unknown[]): string[] {
  const configured = normalizedOfficialIds(values)
  const defaults = defaultIntegrationDisplayOrder()
  return [
    ...configured,
    ...defaults.filter(id => !configured.includes(id)),
  ]
}

export function defaultIntegrationPreferences(): IntegrationPreferences {
  return {
    version: INTEGRATION_PREFERENCES_VERSION,
    onboarding: { completed: false },
    displayOrder: defaultIntegrationDisplayOrder(),
    displayOrderConfigured: false,
    acknowledgedIntegrationIds: [],
    updatedAt: EPOCH,
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

  const completedAt = parseTimestamp(onboardingRecord.completedAt)
  const updatedAt = parseTimestamp(input.updatedAt) ?? EPOCH
  // Compatibility with the brief pre-contract Slice B draft: if this flag is
  // absent but a persisted file contains an order, preserve it as configured.
  const displayOrderConfigured = typeof input.displayOrderConfigured === 'boolean'
    ? input.displayOrderConfigured
    : input.displayOrder.length > 0

  return {
    version: INTEGRATION_PREFERENCES_VERSION,
    onboarding: {
      completed: onboardingRecord.completed,
      ...(onboardingRecord.completed && completedAt ? { completedAt } : {}),
    },
    displayOrder: effectiveDisplayOrder(input.displayOrder),
    displayOrderConfigured,
    acknowledgedIntegrationIds: normalizedOfficialIds(input.acknowledgedIntegrationIds),
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
      if (request.onboardingCompleted !== undefined && request.onboardingCompleted !== true) {
        throw new Error('Integration onboarding completion is monotonic')
      }

      const now = new Date().toISOString()
      const onboardingCompleted = current.onboarding.completed || request.onboardingCompleted === true
      const completedAt = onboardingCompleted
        ? current.onboarding.completedAt ?? now
        : undefined
      const hasDisplayOrderUpdate = request.displayOrder !== undefined
      const displayOrder = hasDisplayOrderUpdate
        ? effectiveDisplayOrder(request.displayOrder ?? [])
        : [...current.displayOrder]
      const acknowledgedIntegrationIds = request.acknowledgedIntegrationIds === undefined
        ? [...current.acknowledgedIntegrationIds]
        : normalizedOfficialIds([
            ...current.acknowledgedIntegrationIds,
            ...request.acknowledgedIntegrationIds,
          ])

      const next: IntegrationPreferences = {
        version: INTEGRATION_PREFERENCES_VERSION,
        onboarding: {
          completed: onboardingCompleted,
          ...(completedAt ? { completedAt } : {}),
        },
        displayOrder,
        displayOrderConfigured: current.displayOrderConfigured || hasDisplayOrderUpdate,
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
  EPOCH,
  normalizedOfficialIds,
  effectiveDisplayOrder,
  parseIntegrationPreferences,
  persistIntegrationPreferences,
}
