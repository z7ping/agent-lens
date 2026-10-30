import type { NativeSessionMetricSnapshot, NativeSessionMetricTool, ObservationCandidate } from '@agent-lens/core'

const MAX_TOOL_NAMES=256

function asRecord(value:unknown):Record<string,unknown> {
  return value && typeof value==='object' && !Array.isArray(value)
    ? value as Record<string,unknown> : {}
}
function firstString(row:Record<string,unknown>,keys:readonly string[]):string|undefined {
  for(const key of keys) {
    const v=row[key]
    if(typeof v==='string' && v.trim())return v
  }
  return undefined
}
function count(value:unknown):number|null {
  return typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : null
}
function callIdentity(observation:ObservationCandidate):string|undefined {
  return observation.nativeCallId
    ?? firstString(asRecord(observation.payload),['callId','call_id','toolUseId','tool_use_id'])
}

/**
 * Reuses the same normalized Source observations and tool-name/success
 * conventions as ToolAssetUsageProjection. Retains only totals in memory,
 * never a copy of individual payloads, observation IDs, or tool arguments.
 */
export class NativeSessionMetricAccumulator {
  private readonly tools=new Map<string,NativeSessionMetricTool>()
  private readonly namesByCallId=new Map<string,string>()
  private truncated=false
  private userTurns=0
  private calls=0
  private results=0
  private toolErrors=0
  private errors=0
  private inputTokens:number|null=null
  private outputTokens:number|null=null
  private inputTokensIncomplete=false
  private outputTokensIncomplete=false

  add(observation:ObservationCandidate):void {
    const payload=asRecord(observation.payload)
    switch(observation.kind){
      case 'message.user':
        this.userTurns++
        break
      case 'tool.call':{
        this.calls++
        const name=firstString(payload,['nativeToolName','toolName','tool_name','name'])
        const id=callIdentity(observation)
        if(name && id){
          if(this.namesByCallId.size<8192)this.namesByCallId.set(id,name)
          else this.truncated=true
        }
        const tool=name?this.tool(name):null
        if(tool)tool.callCount++
        else this.truncated=true
        break
      }
      case 'tool.result':{
        this.results++
        const id=callIdentity(observation)
        const name=firstString(payload,['nativeToolName','toolName','tool_name','name'])
          ?? (id?this.namesByCallId.get(id):undefined)
        const failed=payload.success===false || payload.status==='error'
          || payload.isError===true
        if(failed){this.toolErrors++;this.errors++}
        const tool=name?this.tool(name):null
        if(tool){
          tool.resultCount++
          if(failed)tool.errorCount++
          const duration=payload.durationMs ?? payload.duration_ms
          const ms=count(duration)
          if(ms!==null){
            const total=tool.totalDurationMs+ms
            if(Number.isSafeInteger(total)){
              tool.totalDurationMs=total
              tool.durationSampleCount=(tool.durationSampleCount??0)+1
              tool.maxDurationMs=Math.max(tool.maxDurationMs??0,ms)
            }else this.truncated=true
          }
        } else this.truncated=true
        break
      }
      case 'session.lifecycle':{
        const event=payload.event ?? payload.action
        if(event==='turn.error' || event==='assistant.error' || event==='turn.failed')
          this.errors++
        break
      }
      case 'usage':{
        const input=count(payload.inputTokens ?? payload.input_tokens)
        const output=count(payload.outputTokens ?? payload.output_tokens)
        // Source usage records describe one model call/turn. Missing one side
        // never becomes zero. CapturePolicy already ran before this projection.
        // Missing usage fields are unknown, not zero. A known value from
        // another turn must not hide an unobserved side of this turn.
        if(input===null)this.inputTokensIncomplete=true
        else if(!this.inputTokensIncomplete){
          const sum=(this.inputTokens??0)+input
          if(Number.isSafeInteger(sum))this.inputTokens=sum
          else{this.inputTokensIncomplete=true;this.inputTokens=null}
        }
        if(output===null)this.outputTokensIncomplete=true
        else if(!this.outputTokensIncomplete){
          const sum=(this.outputTokens??0)+output
          if(Number.isSafeInteger(sum))this.outputTokens=sum
          else{this.outputTokensIncomplete=true;this.outputTokens=null}
        }
        break
      }
    }
  }

  private tool(name:string):NativeSessionMetricTool|null {
    if(name.length>128)return null
    let value=this.tools.get(name)
    if(value)return value
    if(this.tools.size>=MAX_TOOL_NAMES)return null
    value={nativeToolName:name,callCount:0,resultCount:0,errorCount:0,totalDurationMs:0,durationSampleCount:0,maxDurationMs:null}
    this.tools.set(name,value)
    return value
  }

  snapshot(input:Omit<NativeSessionMetricSnapshot,
    'coverage'|'interactionCount'|'toolCallCount'|'toolResultCount'|'toolErrorCount'
    |'errorCount'|'inputTokens'|'outputTokens'|'tools'> & {complete:boolean}):NativeSessionMetricSnapshot {
    return {
      sourceId:input.sourceId,installationId:input.installationId,
      nativeSessionId:input.nativeSessionId,
      fileIdentity:input.fileIdentity,fileSize:input.fileSize,fileMtimeMs:input.fileMtimeMs,
      parserVersion:input.parserVersion,projectionVersion:input.projectionVersion,
      coverage:input.complete && !this.truncated?'complete':'partial',
      interactionCount:this.userTurns,toolCallCount:this.calls,toolResultCount:this.results,
      toolErrorCount:this.toolErrors,errorCount:this.errors,
      inputTokens:this.inputTokensIncomplete?null:this.inputTokens,
      outputTokens:this.outputTokensIncomplete?null:this.outputTokens,
      computedAt:input.computedAt,
      tools:[...this.tools.values()].sort((a,b)=>a.nativeToolName.localeCompare(b.nativeToolName)),
    }
  }
}
