import assert from 'node:assert/strict'
import test from 'node:test'
import { AGENT_LENS_PROTOCOL_VERSION, type HealthResponseDto, type ReviewResponseDto } from '@agent-lens/protocol'
import { AgentLensClientModel } from './model'
import type { AgentLensApi } from './api'

const slimHealth:HealthResponseDto={
  status:'ok',protocolVersion:AGENT_LENS_PROTOCOL_VERSION,
  storage:{ok:true,schemaVersion:1,details:{schemaKind:'slim-native-session-v1'}},
}

test('Slim Review refresh uses the existing Native Catalog stream without calling retired SQL Review',async()=>{
  let legacyCalls=0
  const api={
    async review():Promise<ReviewResponseDto>{
      legacyCalls++
      throw Error('legacy Review must be unreachable on Slim')
    },
  } as unknown as AgentLensApi
  const model=new AgentLensClientModel(api)
  ;(model as unknown as {snapshot:{health:HealthResponseDto|null}}).snapshot.health=slimHealth
  await model.ensureReview()
  assert.equal(legacyCalls,0)
  assert.equal(model.getSnapshot().review.response,null,'never fabricate SQL Review summaries')
  assert.equal(model.getSnapshot().review.error,'')
  assert.equal(model.getSnapshot().review.nativeRefreshRevision,1)
  await model.ensureReview()
  assert.equal(model.getSnapshot().review.nativeRefreshRevision,1,'cached native init')
  await model.refreshReview()
  assert.equal(model.getSnapshot().review.nativeRefreshRevision,2,'manual refresh re-reads native Catalog')
  await model.loadMoreReview()
  assert.equal(legacyCalls,0,'legacy pagination must stay unreachable')
  model.stop()
})

test('Slim Review filter refresh keeps native-only mode and preserves selected native deep link',async()=>{
  let legacyCalls=0
  const model=new AgentLensClientModel({
    review:async()=>{legacyCalls++;throw Error('old database')},
  } as unknown as AgentLensApi)
  ;(model as unknown as {snapshot:{
    health:HealthResponseDto|null
    review:{selectedId:string}
  }}).snapshot.health=slimHealth
  ;(model as unknown as {snapshot:{review:{selectedId:string}}}).snapshot.review.selectedId=
    'native:0123456789abcdef0123456789abcdef'
  await model.refreshReview()
  model.setReviewFilters({projectId:'project-a',status:'clean'})
  await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(model.getSnapshot().review.selectedId,'native:0123456789abcdef0123456789abcdef')
  assert.equal(model.getSnapshot().review.filters.projectId,'project-a')
  assert.equal(model.getSnapshot().review.filters.status,'clean')
  assert.equal(legacyCalls,0)
  assert.equal(model.getSnapshot().review.nativeRefreshRevision,2)
  model.stop()
})
