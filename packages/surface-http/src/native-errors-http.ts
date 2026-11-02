import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CapturePolicyService, NativeSessionMetricsStore, SourceService } from '@agent-lens/core'
import { badRequest, writeJson } from './http-utils'

/** Authorized index retrieval. Source records and tool outputs are never returned here. */
export async function handleNativeErrorIndexRequest(
  request:IncomingMessage,response:ServerResponse,url:URL,
  metrics:NativeSessionMetricsStore,sources:SourceService,policy:CapturePolicyService,
):Promise<boolean>{
  if(url.pathname!=='/api/v1/native-errors')return false
  if(request.method!=='GET'){
    response.setHeader('allow','GET')
    writeJson(response,405,{error:'method_not_allowed'})
    return true
  }
  const accepted=new Set(['sourceId','projectId','toolName','q','from','to','offset','limit'])
  for(const key of url.searchParams.keys()){
    if(!accepted.has(key)||url.searchParams.getAll(key).length!==1)throw badRequest('Invalid filter')
  }
  const sourceId=url.searchParams.get('sourceId')??''
  if(!sourceId||sourceId.length>128)throw badRequest('Invalid sourceId')
  if(!policy.isSourceEnabled(sourceId)){
    writeJson(response,404,{error:'not_found'})
    return true
  }
  const source=sources.list().find(item=>item.manifest.sourceId===sourceId)
  if(!source?.readNativeSessionPage||!metrics.queryErrors||!metrics.overview){
    writeJson(response,503,{state:'unavailable',reason:'native-error-index-unavailable'})
    return true
  }
  const optional=(name:string,max:number)=>{
    const value=url.searchParams.get(name)??undefined
    if(value!==undefined&&(!value.trim()||value.length>max))throw badRequest('Invalid '+name)
    return value
  }
  const projectId=optional('projectId',256)
  const toolName=optional('toolName',128)
  const search=optional('q',128)
  const from=optional('from',40)
  const to=optional('to',40)
  for(const date of [from,to])if(date&&!Number.isFinite(Date.parse(date)))throw badRequest('Invalid date')
  const offsetStr=optional('offset',12)??'0'
  const limitStr=optional('limit',3)??'50'
  if(!/^\d+$/.test(offsetStr)||!/^\d+$/.test(limitStr))throw badRequest('Invalid paging')
  const offset=Number(offsetStr),limit=Number(limitStr)
  if(!Number.isSafeInteger(offset)||limit<1||limit>100)throw badRequest('Invalid paging')
  const scope={sourceId,parserVersion:source.manifest.parserVersion,
    coverageCertified:source.nativeSessionCoverageComplete===true,
    ...(projectId?{projectId}:{}),...(from?{from}:{}),...(to?{to}:{})}
  const [page,overview]=await Promise.all([
    metrics.queryErrors({sourceId,parserVersion:source.manifest.parserVersion,
      limit,offset,...(projectId?{projectId}:{}),...(toolName?{toolName}:{}),
      ...(search?{search}:{}),...(from?{from}:{}),...(to?{to}:{})}),
    metrics.overview(scope),
  ])
  writeJson(response,200,{...page,eligibleSessions:overview.eligibleSessions,
    readySessions:overview.readySessions})
  return true
}
