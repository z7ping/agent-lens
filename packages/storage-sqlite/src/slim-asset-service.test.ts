import assert from 'node:assert/strict'
import test from 'node:test'
import { SqliteSlimStorage } from './slim-storage'

test('skill/MCP/plugin discovered asset state works without Observation/Evidence tables',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'local'})
    const install=await slim.identity.resolveInstallation({
      hostId:host.id,productId:'pi',dataRoot:'/tmp/pi',
    })
    const definition=await slim.assets.resolveDefinition({
      type:'skill',canonicalName:'git-review',
    })
    const binding=await slim.assets.resolveBinding({
      assetId:definition.id,installationId:install.id,
      path:'/tmp/pi/skills/git-review',scope:'installation',
    })
    const state=await slim.assets.recordState({
      assetBindingId:binding.id,state:'installed',value:true,
      observedAt:'2026-10-26T09:00:00Z',evidenceRefs:['legacy-evidence'],
    })
    assert.deepEqual(state.evidenceRefs,[])
    const items=await slim.assetInventory.listByInstallation(install.id)
    assert.equal(items.length,1)
    assert.equal(items[0]?.definition.canonicalName,'git-review')
    assert.equal(items[0]?.states[0]?.value,true)
    assert.deepEqual(items[0]?.states[0]?.evidenceRefs,[])
    assert.deepEqual(slim.db.prepare(`SELECT name FROM sqlite_master
      WHERE name IN ('observations','evidence','asset_state_observations')`).all(),[])
    assert.deepEqual(slim.db.pragma('foreign_key_check'),[])
  }finally{await slim.close()}
})

test('asset identity cannot be silently rebound between runtime profiles',async()=>{
  const slim=await SqliteSlimStorage.createFresh(':memory:')
  try{
    const host=await slim.identity.resolveHost({name:'local'})
    const install=await slim.identity.resolveInstallation({hostId:host.id,productId:'pi'})
    slim.db.prepare(`INSERT INTO runtime_profiles(
      id,installation_id,native_profile_id,first_seen_at,last_seen_at
    ) VALUES ('p1',?,'p1','2026-10-26','2026-10-26'),
             ('p2',?,'p2','2026-10-26','2026-10-26')`)
      .run(install.id,install.id)
    const asset=await slim.assets.resolveDefinition({
      type:'mcp',canonicalName:'filesystem',
    })
    await slim.assets.resolveBinding({
      assetId:asset.id,installationId:install.id,path:'mcp-filesystem',
      runtimeProfileId:'p1',
    })
    await assert.rejects(slim.assets.resolveBinding({
      assetId:asset.id,installationId:install.id,path:'mcp-filesystem',
      runtimeProfileId:'p2',
    }),/collision/)
  }finally{await slim.close()}
})
