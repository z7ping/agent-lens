import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root=join(dirname(fileURLToPath(import.meta.url)),'..')
const entry='scripts/slim-cutover-preflight.ts'
function run(args) {
  return spawnSync(process.execPath,['--import','tsx',entry,...args],{
    cwd:root,encoding:'utf8',timeout:20000,
  })
}

test('slim cutover CLI has no implicit destructive/default action',()=>{
  const result=run([])
  assert.equal(result.status,1)
  assert.match(result.stderr,/Use preflight or stage/)
})
test('preflight refuses write destinations before opening any DB',()=>{
  const result=run(['preflight','--legacy','missing.db','--staging','file.sqlite'])
  assert.equal(result.status,1)
  assert.match(result.stderr,/strictly read-only/)
})
test('stage requires distinct explicit backup and staging destinations',()=>{
  const result=run(['stage','--legacy','missing.db','--backup','backup.db'])
  assert.equal(result.status,1)
  assert.match(result.stderr,/requires both --backup and --staging/)
})
test('preflight refuses missing old database rather than create it',()=>{
  const result=run(['preflight','--legacy','this-database-file-does-not-exist.sqlite'])
  assert.equal(result.status,1)
  assert.match(result.stderr,/Slim cutover refused:/)
  assert.equal(result.stdout,'')
})

test('verify requires explicit staging path and rejects backup/write destinations',()=>{
  const noStaging=run(['verify','--legacy','missing.db'])
  assert.equal(noStaging.status,1)
  assert.match(noStaging.stderr,/Verify requires --staging/)
  const withBackup=run([
    'verify','--legacy','missing.db','--staging','slim.db','--backup','backup.db',
  ])
  assert.equal(withBackup.status,1)
  assert.match(withBackup.stderr,/rejects --backup/)
})
