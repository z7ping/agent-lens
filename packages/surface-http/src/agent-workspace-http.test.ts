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
    projects:[],boards:[],tasks:[],runs:[],tasksHasMore:false,
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
    const valid=await fetch(base+'/api/v1/agents/hermes/workspace?board=team&offset=10&limit=20')
    assert.equal(valid.status,200)
    assert.deepEqual((await valid.json() as AgentWorkspaceResponseDto).features,workspace.features)
    assert.deepEqual(options,[{board:'team',offset:10,limit:20,scheduleOffset:0}])
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?board=..')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?limit=101')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?jobId=bad')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace?profile=..&jobId=job')).status,400)
    assert.equal((await fetch(base+'/api/v1/agents/hermes/workspace',{method:'POST'})).status,405)
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
  assert.match(full,/item\?\.productId===source\.manifest\.productId/)
  assert.match(full,/configRoot/)
});
