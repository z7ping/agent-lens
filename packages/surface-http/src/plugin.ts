import { defineAgentLensPlugin, type AgentLensContext } from '@agent-lens/runtime-cordis'
import { HttpEventHub } from './events'
import { DEFAULT_AGENT_LENS_HTTP_PORT, startHttpSurface, type RunningHttpSurface } from './server'

declare module '@deepseek-ai/cordis' { interface Context { http: RunningHttpSurface } }
export interface HttpSurfacePluginConfig { port?: number }
const manifest={pluginId:'@agent-lens/surface-http',pluginVersion:'1.0.0-alpha.0',apiVersion:'1.0',pluginType:'surface',displayName:'AgentLens HTTP Surface'} as const
const applyHttpSurface=Object.assign(async(ctx:AgentLensContext,config:HttpSurfacePluginConfig={})=>{
 const eventHub=new HttpEventHub()
 ctx.on('observation/committed',event=>{void(async()=>{const observation=await ctx.storage.repositories.observations.get(event.observationId); const sourceSession=observation?await ctx.storage.repositories.sessions.getSourceSession(observation.sourceSessionId):null; eventHub.publish({type:'observation.committed',observationId:event.observationId,...(observation?{logicalSessionId:observation.logicalSessionId,installationId:observation.installationId,...(observation.projectId?{projectId:observation.projectId}:{})}:{}),...(sourceSession?{sourceId:sourceSession.sourceId}:{}),affected:['review','sessions','usage'],emittedAt:new Date().toISOString()})})().catch(()=>{eventHub.publish({type:'observation.committed',observationId:event.observationId,affected:['review','sessions','usage'],emittedAt:new Date().toISOString()})})})
 const surface=await startHttpSurface(ctx.storage,{port:config.port??DEFAULT_AGENT_LENS_HTTP_PORT,eventHub,sources:ctx.sources,capabilities:ctx.capabilities})
 const unprovide=ctx.provide('http',surface)
 return async()=>{unprovide();eventHub.close();await surface.dispose()}
},{inject:['storage','sources','capabilities']})
export const httpSurfacePlugin=defineAgentLensPlugin(manifest,applyHttpSurface)
