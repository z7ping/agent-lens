import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function run(...args) {
  return spawnSync(process.execPath,['--import','tsx','scripts/slim-reindex-all.ts',...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}
test('all-installations rebuild requires explicit opt-in',()=>{
  const rejected=run('--staging','unused.sqlite')
  assert.equal(rejected.status,1)
  assert.match(rejected.stderr,/--all-installations is required/)
})
test('offline bulk rebuild validates scope before touching file',()=>{
  const invalid=run('--staging','unused.sqlite','--all-installations','--limit','5001')
  assert.equal(invalid.status,1)
  assert.match(invalid.stderr,/between 1 and 5000/)
  const unknown=run('--staging','unused.sqlite','--all-installations','--source','unknown')
  assert.equal(unknown.status,1)
  assert.match(unknown.stderr,/Unknown native Source/)
})
test('all-installations rebuild refuses nonexistent staging DB',()=>{
  const missing=run('--staging','nonexistent-reindex-all.sqlite','--all-installations')
  assert.equal(missing.status,1)
  assert.match(missing.stderr,/Native reindex-all refused/)
  assert.equal(missing.stdout,'')
})
