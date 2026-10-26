import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function run(...args){
  return spawnSync(process.execPath,['--import','tsx','scripts/slim-prepare-cutover.ts',...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}
test('slim preparation never starts without three explicit database paths',()=>{
  const result=run()
  assert.equal(result.status,1)
  assert.match(result.stderr,/requires explicit --legacy, --backup and --staging/)
  assert.equal(result.stdout,'')
})
test('slim preparation rejects equal paths and unbounded native discovery',()=>{
  const equal=run('--legacy','same.db','--backup','same.db','--staging','new.db')
  assert.equal(equal.status,1)
  assert.match(equal.stderr,/three distinct paths/)
  const invalid=run('--legacy','old.db','--backup','backup.db',
    '--staging','new.db','--limit','5001')
  assert.equal(invalid.status,1)
  assert.match(invalid.stderr,/limit must be 1-5000/)
})
test('slim preparation rejects missing original without creating staging or backup',()=>{
  const missing=run('--legacy','missing-old-cutover-source.db',
    '--backup','fresh-prep-backup.db','--staging','fresh-prep-slim.db')
  assert.equal(missing.status,1)
  assert.match(missing.stderr,/Slim prepare refused:/)
  assert.equal(missing.stdout,'')
})
