import assert from 'node:assert/strict'
import test from 'node:test'
import type { NativeReviewWindowDto, NativeSessionSummaryDto, ReviewNodeDto } from '@agent-lens/protocol'
import { NativeFailureScanner, nativeFailureExamples } from './native-failure-examples'

const session:NativeSessionSummaryDto={id:'native:sample',sourceId:'test-agent',
  installationId:'installation',nativeSessionId:'session',locationKind:'native',
  lastActivityAt:'2026-10-30T00:00:00Z'}
const base={at:session.lastActivityAt,capturedAt:session.lastActivityAt,sourceId:session.sourceId,
  payload:null,evidence:[],observationIds:['observation']}
const window=(nodes:ReviewNodeDto[]):NativeReviewWindowDto=>({
  state:'available',sessionId:session.id,sourceId:session.sourceId,
  installationId:session.installationId,nativeSessionId:session.nativeSessionId,
  pagingUnit:'interaction',boundaryIntegrity:'complete',pendingTail:false,
  observationCount:nodes.length,hasMore:false,nextCursor:'end',
  interactions:[{id:'turn',ordinal:2,trigger:'user',startedAt:base.at,endedAt:base.at,nodes}],
})
const failed:Extract<ReviewNodeDto,{type:'tool'}>={...base,id:'tool',type:'tool',name:'shell',status:'error',
  startedAt:base.at,input:{command:'run'},output:'exit code 1'}

test('错误样本保留工具输入、原始输出和用户轮次；不把报错关键词当失败',()=>{
  const value=window([
    {...base,id:'user',type:'message',role:'user',text:'执行任务'},failed,
    {...failed,id:'ok',status:'success',output:'error count: 0'},
    {...base,id:'text',type:'message',role:'assistant',text:'error'},
  ])
  const samples=nativeFailureExamples(session,value)
  assert.equal(samples.length,1)
  assert.equal(samples[0]!.prompt,'执行任务')
  assert.match(samples[0]!.input!,/command/)
  assert.equal(samples[0]!.error,'exit code 1')
  assert.equal(samples[0]!.contextPartial,false)
  assert.equal(nativeFailureExamples(session,value,'other').length,0)
})

test('缺失上下文和截断输出不会伪装成完整失败现场',()=>{
  const samples=nativeFailureExamples(session,window([{...failed,output:'x'.repeat(10000)}]))
  assert.equal(samples[0]!.prompt,null)
  assert.equal(samples[0]!.contextPartial,true)
  assert.equal(samples[0]!.truncated,true)
  assert.equal(samples[0]!.error.length,8192)
})

test('模型明确失败可提取；用户中断不自动计入错误样本',()=>{
  const event={...base,id:'event',type:'event' as const,kind:'session.lifecycle' as const,
    category:'lifecycle' as const,label:'生命周期'}
  const samples=nativeFailureExamples(session,window([
    {...event,payload:{event:'turn.error',message:'rate limit'}},
    {...event,id:'aborted',payload:{event:'turn.aborted'}},
  ]))
  assert.equal(samples.length,1)
  assert.equal(samples[0]!.kind,'runtime')
  assert.match(samples[0]!.error,/rate limit/)
})

test('跨窗口未配对的工具失败结果保留原始输出，输入明确未知',()=>{
  const samples=nativeFailureExamples(session,window([{
    ...base,id:'orphan',type:'event',kind:'tool.result',category:'unknown',label:'工具结果',
    nativeCallId:'call-1',payload:{nativeToolName:'browser',success:false,output:'execution_timeout'},
  }]))
  assert.equal(samples.length,1)
  assert.equal(samples[0]!.input,null)
  assert.equal(samples[0]!.nativeCallId,'call-1')
  assert.equal(samples[0]!.contextPartial,true)
  assert.equal(samples[0]!.error,'execution_timeout')
})

test('目录分页未完成不能声明无错误，停止信号不得提交迟到结果',async()=>{
  const abort=new AbortController()
  const scanner=new NativeFailureScanner({
    async nativeSessions(){abort.abort();return {items:[session],hasMore:false}},
    async nativeReviewById(){throw Error('不应读取')},
  },{sourceIds:null,projectId:'',range:'all'})
  await scanner.next(abort.signal)
  assert.equal(scanner.finished,false)
  assert.equal(scanner.checkedSessions,0)
})
