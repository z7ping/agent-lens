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
  assert.match(html, /16 次工具调用/)
  assert.match(html, /耗时 2分18秒/)
  assert.match(html, /1 次失败/)
  assert.doesNotMatch(html, /<details[^>]*open=""/)
  assert.doesNotMatch(html, /process body/)
})

test('处理详情运行态默认展开以保留实时可观察性', () => {
  const html = renderToStaticMarkup(createElement(TaskProcessGroup, {
    id: 'process:running',
    messageCount: 1,
    toolCount: 2,
    state: 'running',
    children: 'live process body',
  }))
  assert.match(html, /<details[^>]*open=""/)
  assert.match(html, /处理中/)
  assert.match(html, /live process body/)
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
