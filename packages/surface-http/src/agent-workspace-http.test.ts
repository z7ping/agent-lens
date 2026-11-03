import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { AGENT_LENS_PROTOCOL_VERSION, type AgentWorkspaceResponseDto } from '@agent-lens/protocol'
import { handleAgentWorkspaceRequest } from './agent-workspace-http'
import { HttpError } from './http-utils'

test('workspace handler validates source, policy and bounded read options', async () => {
  let allowed=true
  const options: Array<unknown>=[]
  const workspace:AgentWorkspaceResponseDto={
    sourceId:'hermes',
    features:[{id:'boards',availability:'available'}],
    projects:[],projectsHasMore:false,projectsTotal:0,boards:[],boardsTotal:0,boardsHasMore:false,tasks:[],runs:[],runsHasMore:false,taskCommentsHasMore:false,taskLinks:[],taskComments:[],taskEvents:[],taskEventsHasMore:false,tasksHasMore:false,
    schedules:[],schedulesHasMore:false,schedulesTotal:0,
    executions:[],executionsHasMore:false,
    meta:{protocolVersion:AGENT_LENS_PROTOCOL_VERSION,generatedAt:'2026-11-03T00:00:00Z'},
  }
  const server=createServer(async (req,res)=>{
    try {
      const url=new URL(req.url??'','http://127.0.0.1')
      const handled=await handleAgentWorkspaceRequest(
        req,res,url,{hermes:async input=>{options.push(input);return workspace}},
        {list:()=>[{manifest:{sourceId:'hermes'}},{manifest:{sourceId:'pi'}}]} as never,
        {isSourceEnabled:()=>allowed} as never,
        async (sourceId,installationId)=>sourceId==='hermes' && installationId==='install-a' ? '/verified/a' : null,
      )
      if (!handled) {res.statusCode=404;res.end()}
    } catch (error) {
      res.statusCode=error instanceof HttpError?error.statusCode:500
      res.end(JSON.stringify({error:String(error)}))
    }
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const port=(server.address() as AddressInfo).port
  const base='http://127.0.0.1:'+port
  try {
    const valid=await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&board=team&offset=10&limit=20')
    assert.equal(valid.status,200)
    assert.deepEqual((await valid.json() as AgentWorkspaceResponseDto).features,workspace.features)
    assert.deepEqual(options,[{roots:['/verified/a'],board:'team',offset:10,limit:20,scheduleOffset:0,projectOffset:0,boardOffset:0}])
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=unknown')).status,404)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&board=..')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&limit=101')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&runOffset=../../')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&projectOffset=-1')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&jobId=bad')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&taskId=../')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?installationId=install-a&profile=..&jobId=job')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace',{method:'POST'})).status,405)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace/output?jobId=job1&profile=default')).status,404)
    const none=await fetch(base+'/api/v1/agents/pi/workspace')
    assert.equal(none.status,200)
    assert.deepEqual((await none.json() as AgentWorkspaceResponseDto).features,[])
    allowed=false
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace')).status,403)
    assert.equal(options.length,1,'denied requests must not run provider')
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
})

test('workspace source roots are resolved only for authorized source requests', async () => {
  const reader=await import('./agent-workspace-http')
  assert.equal(typeof reader.handleAgentWorkspaceRequest,'function')
  // The full native HTTP composition supplies verified source installation roots;
  // Hermes's process default never authorizes an arbitrary installation in the HTTP layer.
  const source=await import('node:fs/promises')
  const full=await source.readFile(new URL('./slim-server.ts',import.meta.url),'utf8')
  assert.match(full,/facets\.installedProducts/)
  assert.match(full,/record\.productId!==source\.manifest\.productId/)
  assert.match(full,/record\.configRoot/)
});

test('Cron output uses the same source policy boundary as the workspace',async()=>{
  const {createServer}=await import('node:http')
  let calls=0
  const server=createServer(async(req,res)=>{
    try{
      await handleAgentWorkspaceRequest(req,res,new URL(req.url??'/','http://localhost'),
        undefined,{list:()=>[{manifest:{sourceId:'hermes'}}]} as never,
        {isSourceEnabled:()=>true} as never,
        async (_sourceId,installationId)=>installationId==='install-a'?'/verified/root':null,
        {hermes:async options=>{
          calls++
          assert.deepEqual(options,{jobId:'j1',profile:'default',offset:0,roots:['/verified/root']})
          return {sourceId:'hermes',jobId:'j1',profile:'default',files:[],hasMore:false,state:'unavailable'}
        }})
    }catch(error){res.statusCode=error instanceof HttpError?error.statusCode:500;res.end()}
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port
  try{
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace/output?installationId=install-a&jobId=j1&profile=default')).status,200)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace/output?installationId=install-a&jobId=j1&profile=../')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace/output?installationId=install-a&jobId=j1&profile=default&file=../../secret')).status,400)
    assert.equal(calls,1)
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
