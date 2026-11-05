import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isLargeTaskText, TASK_TEXT_WINDOW_SIZE, TASK_TEXT_WINDOW_THRESHOLD,
  taskTextPage, TaskTextWindow } from './TaskTextWindow'
import { TaskSessionProcessText, TaskSessionThinking } from './TaskSessionContent'
import { TaskMessage } from './TaskMessage'

test('64 Ki-character threshold keeps normal text on existing path', () => {
  assert.equal(isLargeTaskText('x'.repeat(TASK_TEXT_WINDOW_THRESHOLD)), false)
  assert.equal(isLargeTaskText('x'.repeat(TASK_TEXT_WINDOW_THRESHOLD + 1)), true)
  assert.equal(taskTextPage('hi', 0).text, 'hi')
})

test('source pages are contiguous, bounded, lossless including surrogate pairs', () => {
  const original = 'x'.repeat(TASK_TEXT_WINDOW_SIZE - 1) + '🛰'
    + 'y'.repeat(TASK_TEXT_WINDOW_SIZE + 90) + 'tail'
  const pages = Array.from({ length: Math.ceil(original.length / TASK_TEXT_WINDOW_SIZE) }, (_, n) =>
    taskTextPage(original, n))
  assert.equal(pages[0]?.end, pages[1]?.start)
  assert.equal(pages[1]?.end, pages[2]?.start)
  assert.equal(pages.map(page => page.text).join(''), original)
  assert.ok(pages.every(page => page.text.length <= TASK_TEXT_WINDOW_SIZE))
  assert.equal(taskTextPage(original, -50).start, 0)
  assert.equal(taskTextPage(original, Number.NaN).start, 0)
  assert.equal(taskTextPage(original, 999999).end, original.length)
})

test('window markup stays bounded for giant originals and does not expose unseen pages', () => {
  const original = 'a'.repeat(1024 * 1024) + 'NEVER-IN-FIRST-PAGE'
  const html = renderToStaticMarkup(createElement(TaskTextWindow, { text: original }))
  assert.match(html, /data-text-window="true"/)
  assert.match(html, /data-window-start="0"/)
  assert.match(html, /data-window-end="16384"/)
  assert.doesNotMatch(html, /NEVER-IN-FIRST-PAGE/)
  assert.ok(html.length < 35_000)
  assert.match(html, /disabled/)
})

test('large Process/Thinking/assistant Markdown bypasses markdown tree, with shared window', () => {
  const original = '# Heading\n' + ('**massive**\n'.repeat(100_000)) + 'END-MARKER'
  const process = renderToStaticMarkup(createElement(TaskSessionProcessText, { text: original }))
  assert.match(process, /data-text-window="true"/)
  assert.doesNotMatch(process, /END-MARKER/)
  assert.doesNotMatch(process, /<h1>/)
  const thinking = renderToStaticMarkup(createElement(TaskSessionThinking, {
    model: { id: 'thinking-large', label: 'Thinking', text: original },
  }))
  // Thinking remains collapsed by default; no large child body is mounted.
  assert.doesNotMatch(thinking, /data-text-window="true"/)
  assert.ok(thinking.length < 8_000)
  const message = renderToStaticMarkup(createElement(TaskMessage, {
    role: 'assistant', text: original,
  }))
  assert.match(message, /data-text-window="true"/)
  assert.doesNotMatch(message, /END-MARKER/)
  assert.ok(message.length < 40_000)
})

test('short Markdown continues to use the original rich renderer', () => {
  const html = renderToStaticMarkup(createElement(TaskSessionProcessText, {
    text: '**This is bold**',
  }))
  assert.match(html, /<strong>This is bold<\/strong>/)
  assert.doesNotMatch(html, /data-text-window="true"/)
})
