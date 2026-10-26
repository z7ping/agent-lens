import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  CapturePolicyService, LiveAdapter, LiveRuntimeState,
  NativeSessionListItem, NativeSessionListReader, SourceService,
} from '@agent-lens/core'
import { nativeLiveHistoryReference } from './live-history-reference'

const adapter={manifest:{liveId:'pi-live',productId:'pi'}} as LiveAdapter
const state={
  runtimeSessionId:'task-1',nativeSessionId:'native-raw-id',
  workspacePath:'/projects/work',status:'ready',isStreaming:false,pendingMessageCount:0,
} as LiveRuntimeState
const sources={list:()=>[
  {manifest:{productId:'pi',sourceId:'pi'}},
  {manifest:{productId:'codex',sourceId:'codex'}},
]} as unknown as SourceService
const permitted={isSourceEnabled:()=>true} as unknown as CapturePolicyService
const item={
  sourceId:'pi',installationId:'install-a',
  nativeSessionId:'native-raw-id',
  reviewSessionId:'native:0123456789abcdef0123456789abcdef',
  lastActivityAt:'2026-10-25T10:00:00.000Z',
  workspacePath:'/projects/work',
  projectId:'project-1',projectName:'Work',
  metricsState:'missing',titleProvenance:'unknown',
} as NativeSessionListItem

function reader(items:NativeSessionListItem[],hasMore=false){
  const calls:Array<{sourceId?:string;search?:string;limit:number}>=[]
  const sessions={
    async query(input:{sourceId?:string;search?:string;limit:number}){
      calls.push(input)
      return {items,hasMore}
    },
  } as NativeSessionListReader
  return {sessions,calls}
}

test('Slim Live history reference resolves exact native session and project with no Legacy SQL',async()=>{
  const {sessions,calls}=reader([item])
  const found=await nativeLiveHistoryReference(sessions,sources,permitted,adapter,state)
  assert.deepEqual(found,{
    historySessionId:item.reviewSessionId,projectId:item.projectId,
    projectName:item.projectName,lastActivityAt:item.lastActivityAt,
  })
  assert.deepEqual(calls,[{sourceId:'pi',search:'native-raw-id',limit:100}])
})

test('Slim Live history reference refuses reused identity, ambiguous/truncated query and workspace drift',async()=>{
  const duplicate={...item,installationId:'install-b'}
  for(const [items,hasMore] of [
    [[item,duplicate],false],[[item],true],
    [[{...item,workspacePath:'/projects/other'}],false],
  ] as const){
    const {sessions}=reader([...items],hasMore)
    assert.deepEqual(await nativeLiveHistoryReference(
      sessions,sources,permitted,adapter,state),{})
  }
})

test('Slim Live history reference never searches a disabled Source or guesses mismatched IDs',async()=>{
  const {sessions,calls}=reader([item])
  const disabled={isSourceEnabled:()=>false} as unknown as CapturePolicyService
  assert.deepEqual(await nativeLiveHistoryReference(sessions,sources,disabled,adapter,state),{})
  assert.deepEqual(calls,[])
  assert.deepEqual(await nativeLiveHistoryReference(sessions,sources,permitted,adapter,{
    ...state,logicalSessionId:'native:ffffffffffffffffffffffffffffffff',
  }),{})
})
