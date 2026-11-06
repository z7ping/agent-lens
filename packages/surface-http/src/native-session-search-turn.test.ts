import assert from 'node:assert/strict'
import test from 'node:test'
import type { SourceNativeSessionCursor } from '@agent-lens/core'
import { nativeSearchTurnPage } from './native-session-search-http'

const fingerprint = (n: number) => n.toString(16).padStart(64,'0')
const cursor = (offset: number, fileIdentity = 'pi:inode-1'): SourceNativeSessionCursor => ({
  offset,sequence:offset,fileIdentity,recordFingerprint:fingerprint(offset),
})
const observation = (kind: string, nativeEventId?: string) => ({
  kind,...(nativeEventId ? {nativeEventId} : {}),
})

test('Pi body search maps individual observation hits to physical user-turn boundaries across pages', () => {
  const page1 = nativeSearchTurnPage([
    observation('message.user','user-1'),
    observation('message.assistant','answer-1'),
    observation('tool.result','tool-1'),
    observation('message.user','user-2'),
  ], [cursor(0),cursor(1),cursor(2),cursor(3)], undefined, 0, cursor(4))
  assert.deepEqual(page1.turns.map(item=>item?.ordinal),[1,1,1,2])
  assert.deepEqual(page1.turns[2],{
    ordinal:1,nativeEventId:'user-1',recordOffset:0,recordFingerprint:fingerprint(0),
  })
  const page2=nativeSearchTurnPage([
    observation('tool.call','tool-2'),
    observation('tool.result','tool-2'),
    observation('message.user','user-3'),
  ],[cursor(4),cursor(5),cursor(6)],page1.tracker,4,cursor(7))
  assert.deepEqual(page2.turns.map(item=>item?.ordinal),[2,2,3])
  assert.deepEqual(page2.turns[0],{
    ordinal:2,nativeEventId:'user-2',recordOffset:3,recordFingerprint:fingerprint(3),
  })
  assert.equal(page2.tracker.ordinal,3)
})

test('multiple observations in one native physical record count as one user boundary',()=>{
  const row=nativeSearchTurnPage([
    observation('message.user','user-x'),
    observation('message.assistant','assistant-x'),
    observation('tool.call','tool-x'),
  ],[cursor(0),cursor(0),cursor(0)],undefined,0,cursor(100))
  assert.deepEqual(row.turns.map(item=>item?.ordinal),[1,1,1])
})

test('missing or unordered source boundaries disable mapping without suppressing text search',()=>{
  const input=[observation('message.user','user-a'),observation('message.assistant')]
  const noCursor=nativeSearchTurnPage(input,undefined,undefined,0,cursor(2))
  assert.deepEqual(noCursor.turns,[undefined,undefined])
  assert.equal(noCursor.tracker.valid,false)
  const later=nativeSearchTurnPage(input,[cursor(2),cursor(3)],noCursor.tracker,2,cursor(4))
  assert.equal(later.turns[1],undefined,'a later page cannot rebuild skipped user-turn ordinals')
  const reversed=nativeSearchTurnPage(input,[cursor(1),cursor(0)],undefined,0,cursor(2))
  assert.equal(reversed.tracker.valid,false)
  const wrongFile=nativeSearchTurnPage(input,[cursor(0,'wrong'),cursor(1)],undefined,0,cursor(2))
  assert.equal(wrongFile.tracker.valid,false)
})

test('unknown native ID or SHA-256 does not fabricate a jump target',()=>{
  const withoutId=nativeSearchTurnPage([
    observation('message.user'),observation('message.assistant'),
  ],[cursor(0),cursor(1)],undefined,0,cursor(2))
  assert.deepEqual(withoutId.turns,[undefined,undefined])
  const missingHash:SourceNativeSessionCursor={offset:3,sequence:3,fileIdentity:'pi:inode-1'}
  const absent=nativeSearchTurnPage([
    observation('message.user','user-c'),observation('tool.result'),
  ],[missingHash,cursor(4)],withoutId.tracker,2,cursor(5))
  assert.equal(absent.turns[0],undefined)
  assert.equal(absent.turns[1],undefined)
})

test('two different user messages sharing a native record are not assigned a guessed ordinal',()=>{
  const page=nativeSearchTurnPage([
    observation('message.user','user-1'),observation('message.user','user-2'),
  ],[cursor(0),cursor(0)],undefined,0,cursor(1))
  assert.equal(page.turns[0]?.ordinal,1)
  assert.equal(page.turns[1],undefined)
  assert.equal(page.tracker.valid,false)
})
