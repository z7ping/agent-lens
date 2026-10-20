import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskProcessGroup } from './TaskProcessGroup'
import { taskPreciseDurationLabel } from './task-detail-model'

test('处理详情完成态默认折叠并展示统一摘要', () => {
  const html = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:test',
    messageCount: 8,
    toolCount: 16,
    errorCount: 1,
    durationMs: 138_000,
    children: 'process body',
  }))
  assert.match(html, /处理详情/)
  assert.match(html, /8 条消息/)
  assert.doesNotMatch(html, /lucide-brain-circuit|lucide-brain/)
  assert.equal((html.match(/<summary/g) ?? []).length, 1)
  assert.match(html, /16 次工具调用/)
  assert.match(html, /耗时 2分18秒/)
  assert.match(html, /1 次失败/)
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.doesNotMatch(html, /process body/)
})

test('处理详情运行态默认折叠，展开仍能实时观察', () => {
  const html = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:running',
    messageCount: 1,
    toolCount: 2,
    state: 'running',
    children: 'live process body',
  }))
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.match(html, /处理中/)
  assert.doesNotMatch(html, /live process body/)
  const expanded = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:running', messageCount: 1, toolCount: 2,
    state: 'running', defaultExpanded: true, children: 'live process body',
  }))
  assert.match(expanded, /live process body/)
})

test('思考耗时只在可靠可用时进入同一处理详情标题，不增加第二层 disclosure', () => {
  const html = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:duration', messageCount: 3, toolCount: 2,
    thinkingDurationMs: 42_000, durationMs: 86_000, defaultExpanded: true,
    children: '思考正文和工具',
  }))
  assert.match(html, /处理详情（思考了 42秒）/)
  assert.match(html, /3 条消息/)
  assert.match(html, /2 次工具调用/)
  assert.match(html, /耗时 1分26秒/)
  assert.equal((html.match(/<summary/g) ?? []).length, 1)
  assert.equal((html.match(/思考了 42秒/g) ?? []).length, 1)
  assert.match(html, /思考正文和工具/)
  const unknown = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:unknown', messageCount: 1, toolCount: 1,
    durationMs: 86_000, thinkingDurationMs: Number.NaN, children: '正文',
  }))
  assert.doesNotMatch(unknown, /思考了/)
})

test('精确耗时保留秒级而不复用分钟近似格式', () => {
  assert.equal(taskPreciseDurationLabel(18_500), '18秒')
  assert.equal(taskPreciseDurationLabel(138_900), '2分18秒')
  assert.equal(taskPreciseDurationLabel(3_783_900), '1小时3分3秒')
})


test('处理详情优先按真实过程起止计算耗时', () => {
  const html = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:timing',
    messageCount: 1,
    toolCount: 1,
    durationMs: 999_000,
    startedAtMs: Date.parse('2026-09-01T00:00:01.000Z'),
    endedAtMs: Date.parse('2026-09-01T00:00:03.500Z'),
    children: 'body',
  }))
  assert.match(html, /耗时 2秒/)
  assert.doesNotMatch(html, /16分/)
})

test('思考与工具分别统计，不把推理误算为工具', () => {
  const html = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:separate',
    messageCount: 1,
    thinkingCount: 2,
    toolCount: 3,
    state: 'running',
    defaultExpanded: true,
    children: 'process details',
  }))
  assert.match(html, /1 条消息/)
  assert.match(html, /2 段思考/)
  assert.match(html, /3 次工具调用/)
  assert.match(html, /process details/)
})

test('运行中默认可展开，历史默认折叠且没有强制完成态折叠', () => {
  const running = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:active', messageCount: 0, thinkingCount: 1, toolCount: 2,
    state: 'running', defaultExpanded: true,
    children: '执行中',
  }))
  assert.match(running, /执行中/)
  const settled = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:settled', messageCount: 0, thinkingCount: 1, toolCount: 2,
    state: 'settled', defaultExpanded: false,
    children: '执行细节',
  }))
  assert.doesNotMatch(settled, /执行细节/)
})
