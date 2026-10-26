import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import * as storage from './index'

const pkg=resolve(dirname(fileURLToPath(import.meta.url)),'..')

test('M6 has no production Legacy storage, event repositories or 38-version migrator',()=>{
  for(const name of ['storage.ts','provider.ts','plugin.ts','repositories.ts',
    'migrations.ts','session-summaries.ts','source-record-compression.ts',
    'tool-usage-observations.ts','task-file-changes.ts']){
    assert.equal(existsSync(resolve(pkg,'src',name)),false,name)
  }
  assert.equal(existsSync(resolve(pkg,'migrations')),false)
  for(const key of ['SqliteStorageService','sqliteStorageProvider','sqliteStoragePlugin',
    'migrateDatabase','createSqliteRepositories']){
    assert.equal(key in storage,false,key)
  }
})

test('M3 may construct v38 only from isolated test fixtures',()=>{
  const fixture=readFileSync(resolve(pkg,'src','legacy-v38-test-fixture.ts'),'utf8')
  assert.match(fixture,/\.\.\/fixtures\/legacy-v38\//)
  assert.equal(existsSync(resolve(pkg,'fixtures','legacy-v38','038-native-session-metrics.sql')),true)
  const slim=readFileSync(resolve(pkg,'src','slim.ts'),'utf8')
  assert.doesNotMatch(slim,/legacy-v38-test-fixture|SqliteStorageService|migrateDatabase/)
})
