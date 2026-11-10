import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import type { NativeBodySearchHitDto, NativeReviewTurnIndexResponseDto } from '@agent-lens/protocol'
import { verifiedNativeSearchHitTurn } from './native-search-turn-target'

const hit: NativeBodySearchHitDto = {
  sessionId:'native:'+'a'.repeat(32),
  sourceId:'pi',installationId:'local',nativeSessionId:'session-1',
  lastActivityAt:'2026-11-06T00:00:00Z',
  observationId:'observation-11',kind:'tool.result',at:'2026-11-06T00:00:00Z',
  excerpt:'matching content',
  turn:{ordinal:8,nativeEventId:'user-8',recordOffset:2048,
    recordFingerprint:'a'.repeat(64)},
}
const index: NativeReviewTurnIndexResponseDto = {
  state:'available',coverage:'partial',knownTurns:8,scannedOffset:2500,hasMore:true,
  items:[{ordinal:8,nativeEventId:'user-8',cursor:'native-verified-cursor'}],
}

test('Source-backed candidate navigates only after native sparse index agrees',()=>{
  assert.equal(verifiedNativeSearchHitTurn(hit,index),8)
  const {turn: _turn, ...noCandidate}=hit
  assert.equal(verifiedNativeSearchHitTurn(noCandidate,index),undefined)
  const wrongOrdinal={...index,items:[{ordinal:7,nativeEventId:'user-8',cursor:'cursor'}]}
  assert.equal(verifiedNativeSearchHitTurn(hit,wrongOrdinal),undefined)
  const wrongId={...index,items:[{ordinal:8,nativeEventId:'different',cursor:'cursor'}]}
  assert.equal(verifiedNativeSearchHitTurn(hit,wrongId),undefined)
  const missingCursor={...index,items:[{ordinal:8,nativeEventId:'user-8',cursor:''}]}
  assert.equal(verifiedNativeSearchHitTurn(hit,missingCursor),undefined)
  assert.equal(verifiedNativeSearchHitTurn(hit,{state:'drifted',reason:'source-changed'}),undefined)
  assert.equal(verifiedNativeSearchHitTurn(hit,{...index,items:[...index.items,...index.items]}),undefined)
})

test('TaskCenter uses server-verified Source cursor, not guessed observation index or text matching',()=>{
  const page=readFileSync(new URL('./TaskCenterPage.tsx',import.meta.url),'utf8')
  assert.match(page,/model\.nativeReviewTurnIndex\(hit\.sessionId/)
  assert.match(page,/expectedNativeEventId: hit\.turn\.nativeEventId/)
  assert.match(page,/expectedRecordOffset: hit\.turn\.recordOffset/)
  assert.match(page,/expectedRecordFingerprint: hit\.turn\.recordFingerprint/)
  assert.match(page,/verifiedNativeSearchHitTurn\(hit, index\)/)
  assert.match(page,/navigate\(`\/review\/\$\{encodeURIComponent\(hit\.sessionId\)\}\?focusTurn=\$\{ordinal\}`\)/)
  assert.match(page,/setNativeBodyHits\(page\.items\.slice\(0, 100\)\)/)
  assert.match(page,/hit\.observationId/)
  assert.doesNotMatch(page,/indexOf\(hit\.excerpt\)/)
})
