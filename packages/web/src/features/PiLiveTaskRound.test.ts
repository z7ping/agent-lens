import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { hasPiLiveResponseActivity, PiLiveCurrentTaskRound, PiLiveHistoryTaskRound, PiLiveIndexedTaskRound, piLiveLifecycleSummary } from './PiLiveTaskRound'

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


test('Pi 当前轮次一旦出现 Final，上方 Process 即使收到 running 标记也按 settled 展示', () => {
  const html = renderToStaticMarkup(createElement(PiLiveCurrentTaskRound, {
    model: {
      id: 'pi-live-current-round',
      semanticId: 'pi-live-current-round',
      label: '当前轮次',
      state: 'running',
      toolCount: 0,
      errorCount: 0,
      durationMs: 0,
      highLatency: false,
    },
    promptText: '检查项目',
    items: [
      { id: 'thinking-live', kind: 'thinking', text: '仍在分析', at: '2026-09-20T03:00:01.000Z', state: 'running' },
      { id: 'final-live', kind: 'message', role: 'assistant', text: '已经给出结果', at: '2026-09-20T03:00:02.000Z', state: 'running' },
    ],
    pendingMessageCount: 0,
  }))

  assert.match(html, /data-task-round-state="running"/)
  assert.match(html, /data-task-thinking-state="settled"/)
  assert.match(html, /已经给出结果/)
  assert.doesNotMatch(html, /仍在分析/)
})

test('Pi Indexed 关键事件按 Final 前后位置展示，Terminal 最后结算', () => {
  const html = renderToStaticMarkup(createElement(PiLiveIndexedTaskRound, {
    item: {
      cursor: 'user-indexed-order',
      ordinal: 4,
      summary: {
        promptText: '检查顺序',
        finalText: '最终正文',
        events: [
          { id: 'before', category: 'model', label: '模型已切换', detail: 'model-b', phase: 'before-final' },
          { id: 'after', category: 'context', label: '上下文已压缩', detail: 'done', phase: 'after-final' },
        ],
        terminal: { status: 'completed', detail: 'stop' },
        process: {
          revision: 'rev-indexed-order',
          itemCount: 0,
          messageCount: 0,
          toolCount: 0,
          errorCount: 0,
          durationMs: 0,
          availability: 'available',
        },
      },
    },
    loadProcess: async () => ({ items: [], partial: false }),
  }))
  const before = html.indexOf('模型已切换')
  const final = html.indexOf('最终正文')
  const after = html.indexOf('上下文已压缩')
  const terminal = html.indexOf('本轮完成')
  assert.ok(before >= 0 && final > before && after > final && terminal > after)
})
