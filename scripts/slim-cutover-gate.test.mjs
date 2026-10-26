import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function run(...args){
  return spawnSync(process.execPath,['--import','tsx','scripts/slim-cutover-gate.ts',...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}
test('comprehensive cutover gate needs explicit original, backup, staging',()=>{
  const result=run()
  assert.equal(result.status,1)
  assert.match(result.stderr,/requires explicit --legacy, --backup and --staging/)
})
test('cutover gate rejects unbounded full-source recovery',()=>{
  const result=run('--legacy','old.sqlite','--backup','backup.sqlite',
    '--staging','slim.sqlite','--max-pages','16385')
  assert.equal(result.status,1)
  assert.match(result.stderr,/max pages must be 1-16384/)
})
test('missing DBs cannot be silently created or swapped by the gate',()=>{
  const result=run('--legacy','nonexistent.sqlite','--backup','missing-backup.sqlite',
    '--staging','nonexistent-staging.sqlite')
  assert.equal(result.status,1)
  assert.match(result.stderr,/Slim cutover gate refused:/)
  assert.equal(result.stdout,'')
})
