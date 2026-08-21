import type { CheckpointRepository } from '@agent-lens/core'
import { SqliteExecutor } from './executor'

function encode(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new TypeError('Checkpoint values must be JSON-serializable')
  }
  return encoded
}

export class SqliteCheckpointRepository implements CheckpointRepository {
  constructor(private readonly executor: SqliteExecutor) {}

  async get<T>(scope: string, key: string): Promise<T | null> {
    return this.executor.run(() => {
      const row = this.executor.db.prepare(`
        SELECT value_json
        FROM source_checkpoints
        WHERE scope = ? AND checkpoint_key = ?
      `).get(scope, key) as { value_json: string } | undefined

      return row ? JSON.parse(row.value_json) as T : null
    })
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    const valueJson = encode(value)
    await this.executor.run(() => {
      this.executor.db.prepare(`
        INSERT INTO source_checkpoints(scope, checkpoint_key, value_json, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, checkpoint_key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
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
