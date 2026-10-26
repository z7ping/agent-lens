import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  assert.match(entry, /export \{ readActiveDatabasePointer \} from '\.\/slim-active-pointer'/)
  assert.doesNotMatch(entry, /(?:\bfrom\s+['"]\.\/(?:storage|migrations|provider|plugin|repositories|replication)|export \*)/)
})
