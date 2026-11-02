import assert from 'node:assert/strict'
import test from 'node:test'
import type { ObservationCandidate } from '@agent-lens/core'
import { NativeErrorIndexAccumulator } from './native-error-index'

function observation(payload:unknown,kind:'tool.result'|'session.lifecycle'='tool.result'):ObservationCandidate {
  return {kind,occurredAt:'2026-11-02T00:00:00Z',capturedAt:'2026-11-02T00:00:00Z',
    identityHints:{},payload}
}

test('all explicit failures are retained; successes and keyword-only errors are excluded',()=>{
  const accumulator=new NativeErrorIndexAccumulator()
  for(let i=0;i<31;i++)accumulator.add(
    observation({success:false,nativeToolName:'bash',code:'EXIT_1',message:'exit 1'}),String(i),0)
  accumulator.add(observation({success:true,output:'error count: 0'}),'success',0)
  accumulator.add(observation({event:'turn.error',message:'runtime failed'},'session.lifecycle'),'lifecycle',0)
  assert.equal(accumulator.errors.length,32)
  assert.equal(new Set(accumulator.errors.map(x=>x.eventKey)).size,32)
  assert.equal(accumulator.errors[0]?.fingerprint,accumulator.errors[1]?.fingerprint)
  assert.equal(accumulator.errors[0]?.turnOrdinal,null)
})

test('indexed summaries are truncated and redact common credentials',()=>{
  const accumulator=new NativeErrorIndexAccumulator()
  accumulator.add(observation({isError:true,nativeToolName:'shell',
    message:'failure bearer abcdef123456 token=private-value '+ 'x'.repeat(500)}),'native',0)
  assert.equal(accumulator.errors.length,1)
  assert.equal(accumulator.errors[0]?.summary.includes('private-value'),false)
  assert.equal(accumulator.errors[0]?.summary.includes('abcdef123456'),false)
  assert.ok((accumulator.errors[0]?.summary.length??0)<=240)
})
