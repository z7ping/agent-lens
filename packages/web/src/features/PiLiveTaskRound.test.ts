import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hasPiLiveResponseActivity, PiLiveHistoryTaskRound, PiLiveIndexedTaskRound, piLiveLifecycleSummary } from './PiLiveTaskRound'

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


test('Pi Live 历史轮将处理中间过程默认折叠且最终输出保留模型', () => {
  const html = renderToStaticMarkup(createElement(PiLiveHistoryTaskRound, {
    projection: {
      continuation: false,
      model: {
        id: 'round-1:0',
        semanticId: 'round-1',
        ordinal: 1,
        label: '第 1 轮',
        state: 'settled',
        toolCount: 1,
        errorCount: 0,
        durationMs: 138_000,
        highLatency: false,
      },
      items: [
        { id: 'user-1', kind: 'message', role: 'user', text: '检查仓库', at: '2026-09-01T00:00:00.000Z', turnSection: 'prompt' },
        { id: 'thinking-1', kind: 'thinking', text: '先检查状态', at: '2026-09-01T00:00:01.000Z', turnSection: 'process' },
        { id: 'tool-1', kind: 'tool', callId: 'tool-1', name: 'bash', summary: 'git status', output: 'clean', status: 'success', at: '2026-09-01T00:00:02.000Z', turnSection: 'process' },
        { id: 'assistant-1', kind: 'message', role: 'assistant', text: '仓库正常。', modelLabel: 'test / model-1', at: '2026-09-01T00:00:03.000Z', turnSection: 'final' },
      ],
    },
  }))

  assert.match(html, /处理详情/)
  assert.match(html, /1 条消息/)
  assert.match(html, /1 次工具调用/)
  assert.match(html, /耗时 1秒/)
  assert.doesNotMatch(html, /耗时 2分18秒/)
  assert.doesNotMatch(html, /先检查状态/)
  assert.doesNotMatch(html, /git status/)
  assert.match(html, /仓库正常。/)
  assert.match(html, /test \/ model-1/)
  assert.match(html, /task-message-copy-action/)
})


test('Pi Indexed 外层 Round 不重复展示 Process 耗时', () => {
  const html = renderToStaticMarkup(createElement(PiLiveIndexedTaskRound, {
    item: {
      cursor: 'user-indexed',
      ordinal: 3,
      preview: '检查项目',
      summary: {
        promptText: '检查项目',
        finalText: '完成',
        process: {
          revision: 'rev-indexed',
          itemCount: 2,
          messageCount: 1,
          toolCount: 1,
          errorCount: 0,
          durationMs: 12_000,
          availability: 'available',
        },
      },
    },
    loadProcess: async () => ({ items: [], partial: false }),
  }))
  assert.equal((html.match(/耗时 12秒/g) ?? []).length, 1)
})
