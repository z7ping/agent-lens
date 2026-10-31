import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeReviewTurnIndex } from './native-review-turn-index-http'
import { matchIndexedNativeReviewTurn } from './live-native-review-anchor'

const id='native:0123456789abcdef0123456789abcdef'
const nativeId='user-from-live'
function reader(result?:{ordinal:number;cursor:string;nativeEventId:string}){
  const calls:unknown[]=[]
  const index={async findByNativeEventId(...args:unknown[]){
    calls.push(args)
    return result
  }} as unknown as Pick<NativeReviewTurnIndex,'findByNativeEventId'>
  return {index,calls}
}
test('native identity maps to the real file ordinal without a nearby-turn assumption',async()=>{
  const {index,calls}=reader({ordinal:9000,nativeEventId:nativeId,cursor:'verified-cursor'})
  assert.deepEqual(await matchIndexedNativeReviewTurn(index,id,
    {ordinal:1,nativeEventId:nativeId},'/root/native.jsonl'),
    {historySessionId:id,ordinal:9000,cursor:'verified-cursor'})
  assert.deepEqual(calls,[[id,nativeId,'/root/native.jsonl']])
})
test('no source file proof, invalid IDs or mismatched lookup fail closed',async()=>{
  const {index,calls}=reader({ordinal:12,nativeEventId:'other',cursor:'wrong'})
  assert.equal(await matchIndexedNativeReviewTurn(index,id,
    {ordinal:10,nativeEventId:nativeId},'/root/native.jsonl'),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,id,{ordinal:10,nativeEventId:nativeId},''),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,'invalid',{ordinal:10,nativeEventId:nativeId},'/root/native.jsonl'),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,id,{ordinal:0,nativeEventId:nativeId},'/root/native.jsonl'),undefined)
  assert.equal(await matchIndexedNativeReviewTurn(index,id,{ordinal:10},'/root/native.jsonl'),undefined)
  assert.equal(calls.length,1)
})
test('no indexed match never invents a locator',async()=>{
  const {index}=reader()
  assert.equal(await matchIndexedNativeReviewTurn(index,id,
    {ordinal:3,nativeEventId:nativeId},'/root/native.jsonl'),undefined)
})
