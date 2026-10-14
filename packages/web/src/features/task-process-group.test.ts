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
  assert.match(html, /lucide-brain-circuit|lucide-brain/)
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
