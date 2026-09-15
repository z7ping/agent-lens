import assert from 'node:assert/strict'
import test from 'node:test'
import { hasPiLiveResponseActivity, piLiveLifecycleSummary } from './PiLiveTaskRound'

test('Pi Live 会话信息摘要只移除页面内重复的 Pi 来源后缀', () => {
  assert.equal(piLiveLifecycleSummary({
    id: 'session-info',
    kind: 'lifecycle',
    event: 'session.info',
    label: '会话信息已更新',
    detail: 'agent-lens · Pi',
    at: '',
  }), 'agent-lens')
})

test('Pi Live 其他生命周期摘要保持原始信息', () => {
  assert.equal(piLiveLifecycleSummary({
    id: 'model-change',
    kind: 'lifecycle',
    event: 'model.changed',
    label: '模型已切换',
    detail: 'deepseek / deepseek-v4-flash',
    at: '',
  }), 'deepseek / deepseek-v4-flash')
  assert.equal(piLiveLifecycleSummary({
    id: 'assistant-stop',
    kind: 'lifecycle',
    event: 'assistant.stop',
    label: 'Pi 响应结束',
    detail: 'stop',
    at: '',
  }), 'stop')
})


test('Pi Live 只在首个智能体活动前保留响应等待态', () => {
  assert.equal(hasPiLiveResponseActivity([]), false)
  assert.equal(hasPiLiveResponseActivity([{
    id: 'user-1',
    kind: 'message',
    role: 'user',
    text: 'hello',
    at: '',
  }]), false)
  assert.equal(hasPiLiveResponseActivity([{
    id: 'thinking-1',
    kind: 'thinking',
    text: '',
    at: '',
    state: 'running',
  }]), true)
  assert.equal(hasPiLiveResponseActivity([{
    id: 'assistant-1',
    kind: 'message',
    role: 'assistant',
    text: '',
    at: '',
    state: 'running',
  }]), true)
  assert.equal(hasPiLiveResponseActivity([{
    id: 'tool-1',
    kind: 'tool',
    callId: 'call-1',
    name: 'read',
    summary: '',
    output: '',
    status: 'running',
    at: '',
  }]), true)
})
