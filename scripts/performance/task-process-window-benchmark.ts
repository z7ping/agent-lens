import { performance } from 'node:perf_hooks'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MarkdownContent } from '../../packages/web/src/components/MarkdownContent'
import { TaskSessionProcessText } from '../../packages/web/src/features/TaskSessionContent'
import { ToolOutputContent } from '../../packages/web/src/features/ToolOutputContent'

/** Reproducible SSR rendering-cost comparison for one huge Process fact.
 * HTML element-tag counts approximate mounted element nodes; real DOM layout
 * and browser memory require the desktop smoke matrix and are NOT measured here.
 *
 * Run: npm run perf:task-process-window
 */
function measure(name: string, view: ReactElement) {
  // GC is optional; absent without --expose-gc. Never assume a clean heap.
  const gc = (globalThis as { gc?: () => void }).gc
  gc?.()
  const before = process.memoryUsage().heapUsed
  const start = performance.now()
  const html = renderToStaticMarkup(view)
  const renderMs = performance.now() - start
  const heapDelta = process.memoryUsage().heapUsed - before
  const elementTags = [...html.matchAll(/<[a-z][a-z0-9-]*(?:\s[^>]*)?>/gi)].length
  return {
    name,
    renderMs: Math.round(renderMs * 100) / 100,
    elementTags,
    htmlBytes: Buffer.byteLength(html),
    heapDeltaBytes: heapDelta,
  }
}

const markdown = '# Review output\n' + ('- Source-backed execution result\n'.repeat(16_000))
const json = '{"items":[' + Array.from({ length: 20_000 }, (_, i) =>
  '{"n":' + i + ',"text":"status recorded"}').join(',') + ']}'

const baseline = measure('prior-full-markdown-render', createElement(MarkdownContent, { text: markdown }))
const pagedMarkdown = measure('new-paged-process-markdown', createElement(TaskSessionProcessText, { text: markdown }))
const pagedJson = measure('new-paged-tool-json', createElement(ToolOutputContent, { text: json }))
const report = {
  benchmark: 'task-large-process-viewer',
  inputChars: { markdown: markdown.length, json: json.length },
  note: 'SSR element tags approximate DOM elements; heap deltas are process snapshots, not browser heap. No Pi/desktop verification.',
  results: [baseline, pagedMarkdown, pagedJson],
}
console.log(JSON.stringify(report, null, 2))
if (pagedMarkdown.htmlBytes > 40_000 || pagedJson.htmlBytes > 40_000) {
  throw new Error('Large Process/Tool Output entered unbounded SSR markup')
}
if (pagedMarkdown.elementTags > 100 || pagedJson.elementTags > 100) {
  throw new Error('Large Process/Tool Output entered unbounded element tree')
}
