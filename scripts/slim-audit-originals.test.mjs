import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=join(dirname(fileURLToPath(import.meta.url)),'..')
function run(...args){
  return spawnSync(process.execPath,['--import','tsx',
    'scripts/slim-audit-originals.ts',...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}
test('deep originals CLI requires explicit staging DB',()=>{
  const result=run()
  assert.equal(result.status,1)
  assert.match(result.stderr,/requires --staging/)
})
test('deep originals CLI disallows unbounded audits',()=>{
  const tooMany=run('--staging','missing.sqlite','--max-sessions','5001')
  assert.equal(tooMany.status,1)
  assert.match(tooMany.stderr,/1-5000/)
  const hugePage=run('--staging','missing.sqlite','--max-pages','16385')
  assert.equal(hugePage.status,1)
  assert.match(hugePage.stderr,/1-16384/)
})
test('deep originals CLI never creates missing DB',()=>{
  const result=run('--staging','this-slim-audit-should-not-exist.sqlite')
  assert.equal(result.status,1)
  assert.match(result.stderr,/Native originals audit refused/)
  assert.equal(result.stdout,'')
})
