import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readIntegrationAuthorizationSync } from '@agent-lens/runtime-cordis'
import { startSlimIntegrations } from './slim-integrations'

test('Slim Integration management reuses persisted preferences, source policy and explicit Live grants',async()=>{
  const root=await mkdtemp(join(tmpdir(),'agent-lens-slim-integrations-'))
  const authorizationPath=join(root,'authorization.json')
  let configured=['pi']
  const policy={
    isSourceEnabled:(id:string)=>configured.includes(id),
    getSourceConfiguration:()=>({
      effectiveEnabledSources:['pi'],configuredEnabledSources:configured,
      source:'file',editable:true,restartRequired:!configured.includes('pi'),
    }),
    async setEnabledSources(next:readonly string[]){
      configured=[...next]
      return this.getSourceConfiguration()
    },
  }
  const integrations=startSlimIntegrations({
    sources:{list:()=>[{manifest:{
      sourceId:'pi',productId:'pi',displayName:'Pi',
    }}]} as never,
    policy:policy as never,lives:{list:()=>[]} as never,
    preferencesPath:join(root,'preferences.json'),
    authorizationPath,scanOnStart:false,
  })
  try{
    assert.deepEqual(integrations.authorization.available('pi'),['live'])
    assert.deepEqual(integrations.authorization.available('unknown'),[])
    const before=await integrations.management.query()
    const pi=before.items.find(item=>item.integrationId==='pi')
    assert.equal(pi?.enabled.effective,true)
    assert.equal(pi?.enabled.editable,true)
    assert.equal(pi?.capabilities.find(x=>x.capability==='live')?.authorization,'required')
    const disabled=await integrations.management.setEnabled('pi',false)
    assert.equal(disabled.configured,false)
    assert.equal(disabled.restartRequired,true)
    const prefs=await integrations.management.updatePreferences({onboardingCompleted:true})
    assert.equal(prefs.onboarding.completed,true)
    assert.equal(integrations.management.preferences().onboarding.completed,true)
    const grants=await integrations.authorization.grant('pi',['live'])
    assert.deepEqual(grants,['live'])
    assert.deepEqual(readIntegrationAuthorizationSync(authorizationPath)?.grants.pi,['live'])
    const after=await integrations.management.query()
    assert.equal(after.items.find(x=>x.integrationId==='pi')
      ?.capabilities.find(x=>x.capability==='live')?.authorization,'granted')
  }finally{await rm(root,{recursive:true,force:true})}
})
