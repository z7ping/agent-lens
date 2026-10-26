import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function run(...args) {
  return spawnSync(process.execPath,['--import','tsx',
    'scripts/slim-reindex-native.ts',...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}

test('native reindex refuses implicit paths and unsupported Source',()=>{
  const missing=run()
  assert.equal(missing.status,1)
  assert.match(missing.stderr,/requires --staging, --source and --installation/)
  const unsupported=run('--staging','missing.db','--source','unknown',
    '--installation','install')
  assert.equal(unsupported.status,1)
  assert.match(unsupported.stderr,/unsupported Source/)
})
test('native reindex rejects unbounded scans before opening DB',()=>{
  const huge=run('--staging','missing.db','--source','pi',
    '--installation','install','--limit','5001')
  assert.equal(huge.status,1)
  assert.match(huge.stderr,/between 1 and 5000/)
})
test('native reindex does not create an absent staging database',()=>{
  const missing=run('--staging','nonexistent-slim-db-expected.sqlite',
    '--source','pi','--installation','install')
  assert.equal(missing.status,1)
  assert.match(missing.stderr,/Native reindex refused/)
  assert.equal(missing.stdout,'')
})
