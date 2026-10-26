import assert from 'node:assert/strict'
import test from 'node:test'
import { startSlimLive } from './slim-live'

const checkpoints={
  async get(){return null},async set(){},async clear(){},
}
const catalog={async getByReviewSessionId(){return null}}
const reader={async read(){return {state:'unavailable',reason:'not-indexed'}}}
const policy={isSourceEnabled:(id:string)=>id==='codex'}

test('Slim Live registers only explicitly authorized and enabled agents',async()=>{
  const disabled=await startSlimLive(
    checkpoints as never,catalog as never,reader as never,
    policy as never,new Set(['pi','hermes']),
  )
  assert.deepEqual(disabled.lives.list().map(x=>x.manifest.productId),[])
  await disabled.dispose()
  const live=await startSlimLive(
    checkpoints as never,catalog as never,reader as never,
    policy as never,new Set(['codex']),
  )
  try{
    assert.deepEqual(live.lives.list().map(x=>x.manifest.productId),['codex'])
    const codex=live.lives.list()[0]!
    assert.ok(codex.capabilities.has('resume'))
    assert.ok(codex.capabilities.has('stream'))
  }finally{await live.dispose();await live.dispose()}
})
