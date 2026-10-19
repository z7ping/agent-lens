import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TaskReadingRound } from './TaskReadingRound'

const model = {
  id: 'round:1', semanticId: 'semantic:1', label: '第 1 轮',
  state: 'settled' as const, preview: '问题', toolCount: 8,
  errorCount: 0, durationMs: 1000, highLatency: false,
}

test('Live/Review 共同阅读容器固定 prompt → process → answer → 文件顺序', () => {
  const html = renderToStaticMarkup(createElement(TaskReadingRound, {
    model,
    prompt: createElement('span', { id: 'prompt' }, '用户请求'),
    process: createElement('span', { id: 'process' }, '处理详情'),
    answer: createElement('span', { id: 'answer' }, '正式答复'),
    footer: createElement('span', { id: 'files' }, '本轮文件变更'),
  }))
  assert.ok(html.indexOf('id="prompt"') < html.indexOf('id="process"'))
  assert.ok(html.indexOf('id="process"') < html.indexOf('id="answer"'))
  assert.ok(html.indexOf('id="answer"') < html.indexOf('id="files"'))
  assert.match(html, /data-round-semantic-id="semantic:1"/)
  assert.match(html, /data-interaction-id="round:1"/)
  assert.doesNotMatch(html, /<details|task-round-summary|第 1 轮<\//)
})

test('Review 和 Live 必须共享一个渲染结构，轮次导航不依赖标题折叠', () => {
  const html = renderToStaticMarkup(createElement(TaskReadingRound, { model, answer: '正文' }))
  assert.equal((html.match(/class="task-reading-round/g) ?? []).length, 1)
  assert.match(html, /正文/)
})
