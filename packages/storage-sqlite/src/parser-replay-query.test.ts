import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceRecord } from '@agent-lens/core'
import { SqliteStorageService } from './storage'

async function setup() {
  const storage = new SqliteStorageService({ path: ':memory:' })
  await storage.migrate()
  await storage.maintenance.ensureDeferredIndexes()
  const now = '2026-09-05T00:00:00.000Z'
  storage.db.prepare(`
    INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at)
    VALUES ('host', 'host', 'test', 'x64', ?, ?)
  `).run(now, now)
  storage.db.prepare(`INSERT INTO agent_products(id, name) VALUES ('codex', 'Codex')`).run()
  storage.db.prepare(`
    INSERT INTO agent_installations(id, host_id, product_id, first_seen_at, last_seen_at)
    VALUES ('install', 'host', 'codex', ?, ?)
  `).run(now, now)
  return storage
}

function insertRecord(
  storage: SqliteStorageService,
  id: string,
  parserVersion: string,
  capturedAt: string,
) {
  storage.db.prepare(`
    INSERT INTO source_records(
      id, source_id, installation_id, source_session_native_id, native_type,
      captured_at, locator_json, payload_json, parser_version
    ) VALUES (?, 'codex', 'install', 'session-native', 'response_item/message', ?, '{}', '{}', ?)
  `).run(id, capturedAt, parserVersion)
}

async function promote(storage: SqliteStorageService, records: SourceRecord[], parserVersion: string) {
  for (const record of records) {
    await storage.repositories.sourceRecords.put({ ...record, parserVersion })
  }
}

test('parser replay drains stale versions with an indexed row-value cursor', async () => {
  const storage = await setup()
  try {
    insertRecord(storage, 'old-a', '1', '2026-09-01T00:00:00.000Z')
    insertRecord(storage, 'old-b', '1', '2026-09-01T00:01:00.000Z')
    insertRecord(storage, 'old-c', '1', '2026-09-01T00:02:00.000Z')
    insertRecord(storage, 'old-d', '2', '2026-08-01T00:00:00.000Z')
    insertRecord(storage, 'current', '3', '2026-07-01T00:00:00.000Z')

    const replay = storage.repositories.sourceRecords.listForParserReplay
    assert.ok(replay)

    const first = await replay('codex', 'install', '3', undefined, 2)
    assert.deepEqual(first.map(record => record.id), ['old-a', 'old-b'])
    assert.deepEqual(new Set(first.map(record => record.parserVersion)), new Set(['1']))
    await promote(storage, first, '3')

    const firstLast = first.at(-1)!
    const second = await replay('codex', 'install', '3', {
      parserVersion: firstLast.parserVersion,
      capturedAt: firstLast.capturedAt,
      id: firstLast.id,
    }, 2)
    assert.deepEqual(second.map(record => record.id), ['old-c'])
    await promote(storage, second, '3')

    const secondLast = second.at(-1)!
    const third = await replay('codex', 'install', '3', {
      parserVersion: secondLast.parserVersion,
      capturedAt: secondLast.capturedAt,
      id: secondLast.id,
    }, 2)
    assert.deepEqual(third.map(record => record.id), ['old-d'])
    assert.equal(third[0]?.parserVersion, '2')
    await promote(storage, third, '3')

    const thirdLast = third.at(-1)!
    const done = await replay('codex', 'install', '3', {
      parserVersion: thirdLast.parserVersion,
      capturedAt: thirdLast.capturedAt,
      id: thirdLast.id,
    }, 2)
    assert.deepEqual(done, [])
  } finally {
    await storage.close()
  }
})

test('parser replay drains 1505 stale records across multiple 500-row pages and versions', async () => {
  const storage = await setup()
  try {
    const insert = storage.db.prepare(`
      INSERT INTO source_records(
        id, source_id, installation_id, source_session_native_id, native_type,
        captured_at, locator_json, payload_json, parser_version
      ) VALUES (?, 'codex', 'install', 'session-native', 'response_item/message', ?, '{}', '{}', ?)
    `)
    const seed = storage.db.transaction(() => {
      const base = Date.parse('2026-01-01T00:00:00.000Z')
      for (let index = 0; index < 1505; index += 1) {
        insert.run(
          `stale-${String(index).padStart(4, '0')}`,
          new Date(base + index).toISOString(),
          index < 1001 ? '1' : '2',
        )
      }
    })
    seed()

    const replay = storage.repositories.sourceRecords.listForParserReplay
    assert.ok(replay)
    const update = storage.db.prepare('UPDATE source_records SET parser_version = ? WHERE id = ?')
    const promotePage = storage.db.transaction((records: SourceRecord[]) => {
      for (const record of records) update.run('3', record.id)
    })

    let cursor: { parserVersion?: string; capturedAt: string; id: string } | undefined
    let processed = 0
    let pages = 0
    const versions: string[] = []
    while (true) {
      const page = await replay('codex', 'install', '3', cursor, 500)
      if (!page.length) break
      pages += 1
      processed += page.length
      const pageVersions = [...new Set(page.map(record => record.parserVersion))]
      assert.equal(pageVersions.length, 1, 'each page must stay inside one equality-constrained parser version')
      versions.push(pageVersions[0]!)
      promotePage(page)
      const last = page.at(-1)!
      cursor = {
        parserVersion: last.parserVersion,
        capturedAt: last.capturedAt,
        id: last.id,
      }
    }

    assert.equal(processed, 1505)
    assert.equal(pages, 5)
    assert.deepEqual(versions, ['1', '1', '1', '2', '2'])
    const stale = storage.db.prepare(`
      SELECT COUNT(*) AS count
      FROM source_records
      WHERE source_id = 'codex' AND installation_id = 'install' AND parser_version != '3'
    `).get() as { count: number }
    assert.equal(stale.count, 0)
  } finally {
    await storage.close()
  }
})

test('parser replay query plan uses the replay index without a temporary sort', async () => {
  const storage = await setup()
  try {
    insertRecord(storage, 'old-a', '1', '2026-09-01T00:00:00.000Z')
    const plan = storage.db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id, captured_at, parser_version
      FROM source_records
      WHERE source_id = ?
        AND installation_id = ?
        AND parser_version = ?
        AND (captured_at, id) > (?, ?)
      ORDER BY captured_at ASC, id ASC
      LIMIT ?
    `).all('codex', 'install', '1', '2026-08-01T00:00:00.000Z', '', 500) as Array<{ detail: string }>
    const details = plan.map(row => row.detail).join('\n')
    assert.match(details, /idx_source_records_parser_replay/)
    assert.doesNotMatch(details, /TEMP B-TREE/i)
  } finally {
    await storage.close()
  }
})
