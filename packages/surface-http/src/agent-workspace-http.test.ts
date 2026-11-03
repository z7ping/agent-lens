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
        async (sourceId,installationId)=>sourceId==='hermes' && installationId==='install-a' ? {root:'/verified/a',executable:'/bin/hermes'} : null,
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
    const post=await fetch(base+'/api/v1/agents/hermes/workspace/action?installationId=install-a',{
      method:'POST',headers:{'content-type':'application/json','x-agent-lens-workspace-action':'confirmed'},
      body:JSON.stringify({confirmed:true,action:{kind:'cron.pause',profile:'default',jobId:'job1'}}),
    })
    assert.equal(post.status,404,'write actions are not enabled without a provider')

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
        async (_sourceId,installationId)=>installationId==='install-a'?{root:'/verified/root'}:null,
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

test('mutations require local confirmation and a registered single installation',async()=>{
  const commands:Array<unknown>=[]
  let enabled=true
  let grant=false
  const server=createServer(async(req,res)=>{
    try{
      await handleAgentWorkspaceRequest(req,res,new URL(req.url??'/','http://localhost'),
        undefined,{list:()=>[{manifest:{sourceId:'hermes'}}]} as never,
        {isSourceEnabled:()=>enabled} as never,
        async (_sourceId,id)=>id==='known'?{root:'/scope/hermes',executable:'/usr/bin/hermes'}:null,
        undefined,{
          hermes:async options=>{
            commands.push(options)
            return {accepted:true,message:'Native CLI accepted'}
          },
        },{
          allowed:scope=>grant && scope.installationId==='known' && scope.root==='/scope/hermes',
          set:async (scope,value)=>{assert.equal(scope.root,'/scope/hermes');grant=value;return grant},
        })
    }catch(error){
      res.statusCode=error instanceof HttpError?error.statusCode:500
      res.setHeader('content-type','application/json')
      res.end(JSON.stringify({message:String(error)}))
    }
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base='http://127.0.0.1:'+(server.address() as AddressInfo).port
  const request=(url:string,confirm:boolean)=>fetch(base+url,{
    method:'POST',headers:{'content-type':'application/json',
      ...(confirm?{'x-agent-lens-workspace-action':'confirmed'}:{})},
    body:JSON.stringify({confirmed:true,action:{kind:'cron.pause',profile:'default',jobId:'job-a'}}),
  })
  try{
    const endpoint='/api/v1/agents/hermes/workspace/action?installationId=known'
    assert.equal((await request(endpoint,false)).status,403)
    assert.equal((await request('/api/v1/agents/hermes/workspace/action?installationId=missing',true)).status,404)
    assert.equal(commands.length,0)
    assert.equal((await request(endpoint,true)).status,403,'ungranted writes must remain forbidden')
    const permission='/api/v1/agents/hermes/workspace/write-access?installationId=known'
    assert.equal((await fetch(base+permission)).status,200)
    assert.equal((await fetch(base+permission,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({confirmed:true,enabled:true})})).status,403)
    assert.equal((await fetch(base+permission,{method:'PUT',headers:{'content-type':'application/json','x-agent-lens-workspace-action':'confirmed'},body:JSON.stringify({confirmed:true,enabled:true})})).status,200)
    assert.equal(grant,true)
    const allowed=await request(endpoint,true)
    assert.equal(allowed.status,200)
    const response=await allowed.json() as {accepted:boolean;installationId:string}
    assert.equal(response.accepted,true)
    assert.equal(response.installationId,'known')
    assert.deepEqual(commands,[{sourceId:'hermes',installationId:'known',roots:['/scope/hermes'],executable:'/usr/bin/hermes',
      action:{kind:'cron.pause',profile:'default',jobId:'job-a'}}])
    const deniedOrigin=await fetch(base+endpoint,{method:'POST',headers:{origin:'http://attacker.invalid','content-type':'application/json','x-agent-lens-workspace-action':'confirmed'},body:JSON.stringify({confirmed:true,action:{kind:'cron.pause',profile:'default',jobId:'job-a'}})})
    assert.equal(deniedOrigin.status,403)
    assert.equal((await fetch(base+permission,{method:'PUT',headers:{'content-type':'application/json','x-agent-lens-workspace-action':'confirmed'},body:JSON.stringify({confirmed:true,enabled:false})})).status,200)
    assert.equal(grant,false)
    assert.equal((await request(endpoint,true)).status,403,'revocation must apply immediately')
    enabled=false
    assert.equal((await request(endpoint,true)).status,403)
    assert.equal(commands.length,1)
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
})
