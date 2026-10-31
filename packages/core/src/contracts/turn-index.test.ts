import assert from 'node:assert/strict'
import test from 'node:test'
import { alignVerifiedNativeTurns } from './turn-index'

const scope = {sameNativeSession:true,sameTurnViewVerified:true,sourceIndexComplete:true,liveIndexComplete:true}

test('same native ids align with different active-branch and file ordinals', () => {
  const result = alignVerifiedNativeTurns([
    {ordinal:1,nativeEventId:'u1'}, {ordinal:2,nativeEventId:'u2'},
  ], [
    {ordinal:1,nativeEventId:'u1'}, {ordinal:2,nativeEventId:'inactive'},
    {ordinal:3,nativeEventId:'u2'},
  ], scope)
  assert.deepEqual(result,{state:'verified',items:[
    {nativeEventId:'u1',liveOrdinal:1,sourceOrdinal:1},
    {nativeEventId:'u2',liveOrdinal:2,sourceOrdinal:3},
  ]})
})

test('unverified scope, partial indexes, duplicate/missing ids, changed branch all fail closed', () => {
  const a=[{ordinal:1,nativeEventId:'a'}]
  const b=[{ordinal:1,nativeEventId:'b'},{ordinal:2,nativeEventId:'a'}]
  assert.deepEqual(alignVerifiedNativeTurns(a,a,{...scope,sameTurnViewVerified:false}),
    {state:'unavailable',reason:'scope-unverified'})
  assert.deepEqual(alignVerifiedNativeTurns(a,a,{...scope,sourceIndexComplete:false}),
    {state:'unavailable',reason:'incomplete-index'})
  assert.deepEqual(alignVerifiedNativeTurns(a,b,scope),{state:'verified',items:[{nativeEventId:'a',liveOrdinal:1,sourceOrdinal:2}]})
  assert.deepEqual(alignVerifiedNativeTurns(a,[...a,...a],scope),
    {state:'unavailable',reason:'duplicate-identity'})
  assert.deepEqual(alignVerifiedNativeTurns([{ordinal:1,nativeEventId:'missing'}],a,scope),
    {state:'unavailable',reason:'missing-anchor'})
  assert.deepEqual(alignVerifiedNativeTurns([
    {ordinal:1,nativeEventId:'b'},{ordinal:2,nativeEventId:'a'},
  ],[
    {ordinal:1,nativeEventId:'a'},{ordinal:2,nativeEventId:'b'},
  ],scope),{state:'unavailable',reason:'out-of-order'})
})
