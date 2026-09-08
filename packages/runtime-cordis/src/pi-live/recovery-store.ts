import type { CheckpointRepository } from '@agent-lens/core'
import type { PiLiveStartInput } from './types'

const PI_LIVE_RECOVERY_SCOPE = 'pi-live'
const PI_LIVE_RECOVERY_KEY = 'recoverable-runtimes-v1'
const PI_LIVE_RECOVERY_VERSION = 1
const MAX_RECOVERABLE_RUNTIMES = 64

export interface PiLiveRecoveryRecord {
  id: string
  input: PiLiveStartInput
  createdAt: string
  updatedAt: string
}

export interface PiLiveRecoveryStore {
  list(): Promise<PiLiveRecoveryRecord[]>
  put(record: PiLiveRecoveryRecord): Promise<void>
  remove(id: string): Promise<void>
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function recoveryInput(value: unknown): PiLiveStartInput | null {
  const input = record(value)
  const cwd = optionalString(input.cwd)
  if (!cwd) return null
  const provider = optionalString(input.provider)
  const model = optionalString(input.model)
  const name = optionalString(input.name)
  const sessionDir = optionalString(input.sessionDir)
  const sessionPath = optionalString(input.sessionPath)
  const historyAction = input.historyAction === 'continue' || input.historyAction === 'fork'
    ? input.historyAction
    : undefined
  return {
    cwd,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(name ? { name } : {}),
    ...(sessionDir ? { sessionDir } : {}),
    ...(sessionPath ? { sessionPath } : {}),
    ...(historyAction ? { historyAction } : {}),
  }
}

function recoveryRecord(value: unknown): PiLiveRecoveryRecord | null {
  const item = record(value)
  const id = optionalString(item.id)
  const input = recoveryInput(item.input)
  if (!id || !input) return null
  const createdAt = optionalString(item.createdAt) ?? new Date(0).toISOString()
  const updatedAt = optionalString(item.updatedAt) ?? createdAt
  return { id, input, createdAt, updatedAt }
}

function normalizeRecord(value: PiLiveRecoveryRecord): PiLiveRecoveryRecord {
  const input = recoveryInput(value.input)
  if (!input) throw new Error('Pi Live recovery record requires a working directory')
  return {
    id: value.id.trim(),
    input,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

export class CheckpointPiLiveRecoveryStore implements PiLiveRecoveryStore {
  private writeTail: Promise<void> = Promise.resolve()

  constructor(private readonly checkpoints: CheckpointRepository) {}

  async list(): Promise<PiLiveRecoveryRecord[]> {
    await this.writeTail
    return this.read()
  }

  put(value: PiLiveRecoveryRecord): Promise<void> {
    const normalized = normalizeRecord(value)
    return this.enqueue(async () => {
      const current = await this.read()
      const next = [normalized, ...current.filter(item => item.id !== normalized.id)]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, MAX_RECOVERABLE_RUNTIMES)
      await this.checkpoints.set(PI_LIVE_RECOVERY_SCOPE, PI_LIVE_RECOVERY_KEY, {
        version: PI_LIVE_RECOVERY_VERSION,
        runtimes: next,
      })
    })
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const current = await this.read()
      const next = current.filter(item => item.id !== id)
      if (next.length === current.length) return
      if (!next.length) {
        await this.checkpoints.clear(PI_LIVE_RECOVERY_SCOPE, PI_LIVE_RECOVERY_KEY)
        return
      }
      await this.checkpoints.set(PI_LIVE_RECOVERY_SCOPE, PI_LIVE_RECOVERY_KEY, {
        version: PI_LIVE_RECOVERY_VERSION,
        runtimes: next,
      })
    })
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writeTail.then(work, work)
    this.writeTail = next.catch(() => undefined)
    return next
  }

  private async read(): Promise<PiLiveRecoveryRecord[]> {
    const stored = await this.checkpoints.get<unknown>(PI_LIVE_RECOVERY_SCOPE, PI_LIVE_RECOVERY_KEY)
    const envelope = record(stored)
    if (envelope.version !== PI_LIVE_RECOVERY_VERSION || !Array.isArray(envelope.runtimes)) return []
    return envelope.runtimes
      .map(recoveryRecord)
      .filter((item): item is PiLiveRecoveryRecord => Boolean(item))
      .slice(0, MAX_RECOVERABLE_RUNTIMES)
  }
}
