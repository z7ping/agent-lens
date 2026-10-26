import assert from 'node:assert/strict'
import test from 'node:test'
import { parseMigrateOnceArgs } from './slim-migrate-once'

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
  assert.equal(p.legacyPath,'/tmp/original-v38.sqlite')
  assert.equal(p.pointerPath,'/tmp/active-database.json')
  assert.notEqual(p.backupPath,p.legacyPath)
  assert.notEqual(p.stagingPath,p.installedSlimPath)
  assert.equal(p.stagingPath.endsWith('.staging.sqlite'),true)
})
