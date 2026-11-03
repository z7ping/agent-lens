import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_LENS_PROTOCOL_VERSION, type NativeSessionCatalogResponseDto } from '@agent-lens/protocol'
import { AgentLensApi } from './api'
import { AgentLensClientModel } from './model'

const session = (id:string, installationId:string) => ({
  id,sourceId:'hermes',nativeSessionId:'original-123',installationId,
  locationKind:'native' as const,lastActivityAt:'2026-11-03T00:00:00Z',
})
test('Hermes work → Review only resolves exact native identity, never title or workspace',async()=>{
  class Api extends AgentLensApi {
    override nativeSessions():Promise<NativeSessionCatalogResponseDto> {
      return Promise.resolve({items:[
        {...session('native:aabbcc','first'),nativeSessionId:'other',title:'original-123'},
        session('native:001122','first'),
      ],hasMore:false})
    }
  }
  const result=await new AgentLensClientModel(new Api()).resolveAgentNativeSession('hermes','original-123')
  assert.deepEqual(result,{state:'linked',reviewSessionId:'native:001122'})
})
test('duplicate native session identities must not produce arbitrary links',async()=>{
  class Api extends AgentLensApi {
    override nativeSessions():Promise<NativeSessionCatalogResponseDto> {
      return Promise.resolve({items:[session('native:aa','first'),session('native:bb','second')],hasMore:false})
    }
  }
  const result=await new AgentLensClientModel(new Api()).resolveAgentNativeSession('hermes','original-123')
  assert.equal(result.state,'ambiguous')
})
test('incomplete catalog pagination must not be treated as a missing session',async()=>{
  class Api extends AgentLensApi {
    override nativeSessions():Promise<NativeSessionCatalogResponseDto> {
      return Promise.resolve({items:[],hasMore:true})
    }
  }
  const result=await new AgentLensClientModel(new Api()).resolveAgentNativeSession('hermes','original-123')
  assert.equal(result.state,'incomplete')
})
