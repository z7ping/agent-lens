import type { CheckpointRepository } from '@agent-lens/core'
import { SqliteExecutor } from './executor'

function encode(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new TypeError('Checkpoint values must be JSON-serializable')
  }
  return encoded
}

export interface VersionedCheckpoint<T> {
  value: T
  revision: number
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get<T>(scope: string, key: string): Promise<T | null> {
    const versioned = await this.getWithRevision<T>(scope, key)
    return versioned?.value ?? null
  }

  async getWithRevision<T>(scope: string, key: string): Promise<VersionedCheckpoint<T> | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT value_json, revision
        FROM source_checkpoints
        WHERE scope = ? AND checkpoint_key = ?
      `).get(scope, key) as { value_json: string; revision: number } | undefined

      return row
        ? { value: JSON.parse(row.value_json) as T, revision: Number(row.revision) }
        : null
    })
  }

  async compareAndSet<T>(
    scope: string,
    key: string,
    expectedRevision: number | null,
    value: T,
  ): Promise<boolean> {
    const valueJson = encode(value)
    return this.executor.run(() => {
      const updatedAt = new Date().toISOString()
      if (expectedRevision === null) {
        const inserted = this.executor.db.prepare(`
          INSERT INTO source_checkpoints(scope, checkpoint_key, value_json, updated_at, revision)
          VALUES (?, ?, ?, ?, 1)
          ON CONFLICT(scope, checkpoint_key) DO NOTHING
        `).run(scope, key, valueJson, updatedAt)
        return Number(inserted.changes) === 1
      }

      const updated = this.executor.db.prepare(`
        UPDATE source_checkpoints
        SET value_json = ?, updated_at = ?, revision = revision + 1
        WHERE scope = ? AND checkpoint_key = ? AND revision = ?
      `).run(valueJson, updatedAt, scope, key, expectedRevision)
      return Number(updated.changes) === 1
    })
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    const valueJson = encode(value)
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO source_checkpoints(scope, checkpoint_key, value_json, updated_at, revision)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(scope, checkpoint_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at,
          revision = source_checkpoints.revision + 1
      `).run(scope, key, valueJson, new Date().toISOString())
    })
  }

  async clear(scope: string, key: string): Promise<void> {
    await this.executor.run(() => {
      this.executor.db.prepare(`
        DELETE FROM source_checkpoints
        WHERE scope = ? AND checkpoint_key = ?
      `).run(scope, key)
    })
  }
}
