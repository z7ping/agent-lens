import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMigrateOnceArgs } from './slim-migrate-once'
import { unresolvedSlimPrepareBlockers } from './slim-prepare-cutover'
import { finalGateArgs } from './slim-cutover-activation'
import { parseSlimGateArgs } from './slim-cutover-gate'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const env={AGENT_LENS_PORT:'56789',AGENT_LENS_DB_PATH:'/tmp/original-v38.sqlite',
  AGENT_LENS_ACTIVE_DB_POINTER:'/tmp/active-database.json'}
const uuid=()=> 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
test('M3 single migration refuses oversized scans, extra options, and invalid port',()=>{
  assert.throws(()=>parseMigrateOnceArgs(['--max-pages','0'],env,uuid),/page limit/)
  assert.throws(()=>parseMigrateOnceArgs(['--max-sessions','5001'],env,uuid),/session limit/)
  assert.throws(()=>parseMigrateOnceArgs(['--force'],env,uuid),/only/)
  assert.throws(()=>parseMigrateOnceArgs([],{...env,AGENT_LENS_PORT:'0'},uuid),/port/)
})
test('M3 migration reserves distinct one-time files without overriding original database',()=>{
  const p=parseMigrateOnceArgs(['--max-sessions','128'],env,uuid)
  assert.equal(p.maxSessions,128)
  assert.equal(p.legacyPath,resolve('/tmp/original-v38.sqlite'))
  assert.equal(p.pointerPath,resolve('/tmp/active-database.json'))
  assert.notEqual(p.backupPath,p.legacyPath)
  assert.notEqual(p.stagingPath,p.installedSlimPath)
  assert.equal(p.stagingPath.endsWith('.staging.sqlite'),true)
})


test('bundled migrator imports never trigger other original script entrypoints',async()=>{
  const root=fileURLToPath(new URL('./',import.meta.url))
  for(const name of ['slim-prepare-cutover','slim-reindex-all','slim-reindex-native',
    'slim-rebuild-metrics-all','slim-cutover-gate','slim-audit-originals',
    'slim-audit-legacy-hooks','slim-cutover-activation']){
    const body=await readFile(resolve(root,name+'.ts'),'utf8')
    assert.match(body,/invocationBaseName\(process\.argv\[1\]\)/)
    assert.equal(body.includes('"slim-migrate.mjs"'),false,
      name+' must not start when bundled as slim-migrate.mjs')
  }
})


test('M3 prepare cannot discard Source enumeration, Hook or numerical failures before final activation',()=>{
  const blocked=unresolvedSlimPrepareBlockers({blockedBy:[
    'full-consumer-and-legacy-writer-retirement-pending',
    'native-source-enumeration-incomplete',
    'native-numerical-metrics-budget-exhausted',
    'hook-and-archival-coverage-not-certified',
    'old-writer-freeze-and-atomic-swap-not-certified',
  ]})
  assert.deepEqual(blocked,[
    'native-source-enumeration-incomplete',
    'native-numerical-metrics-budget-exhausted',
    'hook-and-archival-coverage-not-certified',
  ])
  assert.deepEqual(unresolvedSlimPrepareBlockers({blockedBy:[
    'full-consumer-and-legacy-writer-retirement-pending',
    'old-writer-freeze-and-atomic-swap-not-certified',
  ]}),[])
})

test('M3 final gate uses the SAME bounded native Reader budgets requested for preparation',()=>{
  const args=finalGateArgs({
    legacyPath:'/tmp/old.db',backupPath:'/tmp/backup.db',
    stagingPath:'/tmp/stage.db',installedSlimPath:'/tmp/installed.db',
    pointerPath:'/tmp/active.json',
  },{maxSessions:3000,maxPages:16384})
  const params=parseSlimGateArgs(args)
  assert.equal(params.maxPages,16384)
  assert.equal(params.maxSessions,3000)
  assert.throws(()=>finalGateArgs({legacyPath:'a',backupPath:'b',stagingPath:'c',
    installedSlimPath:'d',pointerPath:'e'},
    {maxSessions:5001,maxPages:16384}),/session limit/)
})
