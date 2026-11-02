import { createHash } from 'node:crypto'
import type { NativeErrorIndexEntry, ObservationCandidate } from '@agent-lens/core'

const MAX_SUMMARY=240
const MAX_CODE=80

function object(value:unknown):Record<string,unknown> {
  return value && typeof value==='object' && !Array.isArray(value)
    ? value as Record<string,unknown> : {}
}
function asString(value:unknown):string|undefined {
  return (typeof value==='string' && value.trim())?value.trim():undefined
}
function first(row:Record<string,unknown>,keys:readonly string[]):string|undefined {
  for(const key of keys){
    const value=asString(row[key])
    if(value)return value
  }
  return undefined
}
function redact(value:string):string {
  // A short diagnostic is not permission to retain credentials or transcript text.
  return value
    .replace(/(?:bearer\s+)[a-z0-9._~+/-]+/gi,'Bearer [redacted]')
    .replace(/(?:password|token|api[_-]?key|secret)\s*[:=]\s*[^\s,;]+/gi,'[redacted]')
    .replace(/\b(?:sk|ghp|gho|github_pat)_[a-z0-9_-]{12,}\b/gi,'[redacted]')
    .replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim()
}
function hash(value:string):string {
  return createHash('sha256').update(value).digest('hex')
}
function diagnostic(payload:Record<string,unknown>):{code:string|null;summary:string} {
  const nested=object(payload.error)
  const output=object(payload.output)
  const result=object(payload.result)
  const code=first(payload,['errorCode','error_code','code'])
    ??first(nested,['code','type'])
  const message=first(payload,['errorMessage','error_message','message','reason','error'])
    ??first(nested,['errorMessage','message','reason'])
    ??first(output,['errorMessage','message','error','reason'])
    ??first(result,['errorMessage','message','error','reason'])
    ?? (typeof payload.output==='string' ? payload.output: undefined)
  return {
    code:code?redact(code).slice(0,MAX_CODE):null,
    // Do not serialize raw payloads, stack traces, tool inputs or user prompts.
    summary:message?redact(message).slice(0,MAX_SUMMARY):'',
  }
}

/** Extract exactly the failures counted by NativeSessionMetricAccumulator.
 * The record ID and record-local index distinguish facts without copying event bodies.
 * A turn ordinal is intentionally unknown for branched sources until verified by Review.
 */
export class NativeErrorIndexAccumulator {
  readonly errors:NativeErrorIndexEntry[]=[]
  private readonly toolNamesByCall=new Map<string,string>()

  add(observation:ObservationCandidate,recordId:string,recordLocalIndex:number):void {
    const payload=object(observation.payload)
    const callId=observation.nativeCallId
      ??first(payload,['callId','call_id','toolUseId','tool_use_id'])
    if(observation.kind==='tool.call' && callId && this.toolNamesByCall.size<8192){
      const name=first(payload,['nativeToolName','toolName','tool_name','name'])
      if(name)this.toolNamesByCall.set(callId,name)
    }
    const tool=observation.kind==='tool.result'
    const lifecycle=observation.kind==='session.lifecycle'
    const failed=tool
      ?payload.success===false||payload.status==='error'||payload.isError===true
      :lifecycle&&['turn.error','assistant.error','turn.failed']
        .includes(String(payload.event??payload.action??''))
    if(!failed)return
    const {code,summary}=diagnostic(payload)
    const name=tool?(first(payload,['nativeToolName','toolName','tool_name','name'])
      ??(callId?this.toolNamesByCall.get(callId):undefined)):undefined
    const kind=tool?'tool' as const:'runtime' as const
    const fingerprint=hash(JSON.stringify([kind,name??null,code,summary.toLowerCase()]))
    this.errors.push({
      eventKey:hash(JSON.stringify([recordId,recordLocalIndex,observation.nativeEventId??null])),
      occurredAt:observation.occurredAt??observation.capturedAt,
      nativeEventId:observation.nativeEventId?.slice(0,256)??null,
      turnOrdinal:null,
      toolName:name?.slice(0,128)??null,
      kind,errorCode:code,summary,fingerprint,
    })
  }
}
