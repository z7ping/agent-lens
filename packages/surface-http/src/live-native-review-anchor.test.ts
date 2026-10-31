import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeReviewTurnIndex } from './native-review-turn-index-http'
import { matchIndexedNativeReviewTurn } from './live-native-review-anchor'

const id='native:0123456789abcdef0123456789abcdef'
const nativeId='user-from-live'
function reader(items:Array<{ordinal:number;cursor:string;nativeEventId:string}>,state='available') {
  const calls:unknown[]=[]
  const index={
    async query(sessionId:string,options:unknown) {
      calls.push([sessionId,options])
      return state==='available'
        ? {state:'available',coverage:'partial',knownTurns:80,items,hasMore:true}
        : {state:'drifted',reason:'native-file-identity-changed'}
    },
  } as unknown as Pick<NativeReviewTurnIndex,'query'>
  return {index,calls}
}

test('same source user ID resolves actual different file ordinal within a bounded indexed prefix',async()=>{
  const {index,calls}=reader([{ordinal:25,nativeEventId:nativeId,cursor:'source-verified-cursor'}])
  assert.deepEqual(await matchIndexedNativeReviewTurn(index,id,{ordinal:3,nativeEventId:nativeId}),{
    historySessionId:id,ordinal:25,cursor:'source-verified-cursor',
  })
  assert.deepEqual(calls,[[id,{from:1,limit:120,expectedNativeEventId:nativeId}]])
})

test('invalid identity and missing exact matches cannot claim a native locator',async()=>{
  const {index,calls}=reader([{ordinal:25,nativeEventId:'other',cursor:'wrong'}])
  assert.equal(await matchIndexedNativeReviewTurn(index,id,{ordinal:3,nativeEventId:nativeId}),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,'native:invalid',{ordinal:3,nativeEventId:nativeId}),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,id,{ordinal:0,nativeEventId:nativeId}),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,id,{ordinal:3}),undefined)
  assert.equal(calls.length,1)
})

test('ambiguous, drifted and out-of-prefix indexes fail closed',async()=>{
  const matched={ordinal:25,nativeEventId:nativeId,cursor:'a'}
  const duplicate=reader([matched,{...matched,cursor:'b'}])
  assert.equal(await matchIndexedNativeReviewTurn(duplicate.index,id,{ordinal:3,nativeEventId:nativeId}),undefined)
  const changed=reader([matched],'drifted')
  assert.equal(await matchIndexedNativeReviewTurn(changed.index,id,{ordinal:3,nativeEventId:nativeId}),undefined)
  const absent=reader([])
  assert.equal(await matchIndexedNativeReviewTurn(absent.index,id,{ordinal:3,nativeEventId:nativeId}),undefined)
})
