import type { CheckpointRepository } from '@agent-lens/core'

const SCOPE = 'codex-live'
const KEY = 'recoverable-threads-v1'
const LIMIT = 64
export interface CodexRecoveryRecord {
  id: string
  cwd: string
  title?: string
  model?: string
  effort?: string
  updatedAt: string
}
export interface CodexRecoveryStore {
  list(): Promise<CodexRecoveryRecord[]>
  put(record: CodexRecoveryRecord): Promise<void>
  remove(id: string): Promise<void>
}
function valid(value: unknown): CodexRecoveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || !row.id || typeof row.cwd !== 'string' || !row.cwd) return null
  return {
    id: row.id,
    cwd: row.cwd,
    ...(typeof row.title === 'string' ? { title: row.title } : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    ...(typeof row.effort === 'string' ? { effort: row.effort } : {}),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date(0).toISOString(),
  }
}

/** Checkpoints are only runtime recovery hints, never a second canonical transcript. */
export class CheckpointCodexRecoveryStore implements CodexRecoveryStore {
  private tail: Promise<void> = Promise.resolve()
  constructor(private readonly checkpoints: CheckpointRepository) {}

  private async read(): Promise<CodexRecoveryRecord[]> {
    const value = await this.checkpoints.get<unknown>(SCOPE, KEY)
    if (!value || typeof value !== 'object') return []
    const data = value as { version?: unknown, threads?: unknown }
    if (data.version !== 1 || !Array.isArray(data.threads)) return []
    return data.threads.map(valid).filter((row): row is CodexRecoveryRecord => row !== null).slice(0, LIMIT)
  }

  async list(): Promise<CodexRecoveryRecord[]> {
    await this.tail
    return this.read()
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const work = this.tail.then(action, action)
    this.tail = work.catch(() => undefined)
    return work
  }

  put(record: CodexRecoveryRecord): Promise<void> {
    const normalized = valid(record)
    if (!normalized) throw new Error('Invalid Codex recovery record')
    return this.enqueue(async () => {
      const previous = await this.read()
      const threads = [normalized, ...previous.filter(item => item.id !== normalized.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, LIMIT)
      await this.checkpoints.set(SCOPE, KEY, { version: 1, threads })
    })
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const old = await this.read()
      const threads = old.filter(row => row.id !== id)
      if (threads.length === old.length) return
      if (!threads.length) await this.checkpoints.clear(SCOPE, KEY)
      else await this.checkpoints.set(SCOPE, KEY, { version: 1, threads })
    })
  }
}
