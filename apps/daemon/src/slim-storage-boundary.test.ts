import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

test('Daemon startup and Data Runtime Worker use only the Slim storage entry', () => {
  for (const relative of [
    './default-slim-db.ts',
    './slim-main.ts',
    './data-runtime/slim-runtime.ts',
    './data-runtime/worker.ts',
  ]) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
    assert.match(source, /from ['"]@agent-lens\/storage-sqlite\/slim['"]/)
    assert.doesNotMatch(source, /from ['"]@agent-lens\/storage-sqlite['"]/)
  }
})

test('Slim public entry cannot re-export Legacy SQL Writers or migration lineage', () => {
  const entry = readFileSync(
    new URL('../../../packages/storage-sqlite/src/slim.ts', import.meta.url), 'utf8',
  )
  assert.match(entry, /export \{ SqliteSlimStorage \} from '\.\/slim-storage'/)
  assert.match(entry, /export \{ readActiveDatabasePointer, type ActiveDatabasePointer \} from '\.\/slim-active-pointer'/)
  assert.doesNotMatch(entry, /(?:\bfrom\s+['"]\.\/(?:storage|migrations|provider|plugin|repositories|replication)|export \*)/)
})

test('M6 removes the legacy writer, migrations, event repositories and Pi HTTP compatibility entry', () => {
  for (const path of [
    '../../../packages/storage-sqlite/migrations',
    '../../../packages/storage-sqlite/src/storage.ts',
    '../../../packages/storage-sqlite/src/migrations.ts',
    '../../../packages/storage-sqlite/src/repositories.ts',
    '../../../packages/storage-sqlite/src/session-summaries.ts',
    '../../../packages/storage-sqlite/src/task-file-changes.ts',
    '../../../packages/surface-http/src/pi-live.ts',
    '../../../packages/runtime-cordis/src/pi-live/history-interaction.ts',
  ]) {
    assert.equal(existsSync(new URL(path, import.meta.url)), false, path)
  }
})
