import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { detectToolOutputFormat, ToolOutputContent } from './ToolOutputContent'

test('only explicit structured data is eligible for a formatted view', () => {
  assert.equal(detectToolOutputFormat('{"sql":"SELECT 1","rows":[1]}'), 'json')
  assert.equal(detectToolOutputFormat('| uuid | name |\n| --- | --- |\n| a | test |'), 'markdown')
  assert.equal(detectToolOutputFormat('Error [MCP_READ_ONLY]: write blocked'), null)
  assert.equal(detectToolOutputFormat('Connecting...\nQuery OK'), null)
  assert.equal(detectToolOutputFormat('SELECT * FROM table WHERE x = 1;'), null)
  assert.equal(detectToolOutputFormat('{"broken":'), null)
  assert.equal(detectToolOutputFormat('```sql\nSELECT 1;\n```'), 'markdown')
  assert.equal(detectToolOutputFormat('```unknown\nhello\n```'), null)
})

test('the original output remains the default and copyable even for Markdown tables', () => {
  const text = '| col | val |\n| --- | --- |\n| 1 | 2 |'
  const html = renderToStaticMarkup(createElement(ToolOutputContent, { text }))
  assert.match(html, /data-view="original"/)
  assert.match(html, /task-tool-output-format-actions/)
  assert.match(html, /copyable-code-block/)
  assert.match(html, /\| --- \| --- \|/)
})

test('Tool JSON output remains copyable and receives language-aware token markup', () => {
  const raw = '{"ok":true,"rows":[1,2]}'
  const html = renderToStaticMarkup(createElement(ToolOutputContent, { text: raw }))
  assert.match(html, /data-code-language="json"/)
  assert.match(html, /token-property|token-string/)
  assert.match(html, /data-view="original"/)
})


test('a giant JSON tool output never enters JSON parsing, Markdown or Prism, but retains full copy source', () => {
  const huge = '{"payload":"' + 'x'.repeat(1024 * 1024) + '","tail":"hidden-tail-marker"}'
  assert.equal(detectToolOutputFormat(huge), null)
  const html = renderToStaticMarkup(createElement(ToolOutputContent, { text: huge }))
  assert.match(html, /data-view="window"/)
  assert.match(html, /data-total-chars="/)
  assert.match(html, /data-window-end="16384"/)
  assert.doesNotMatch(html, /hidden-tail-marker/)
  assert.doesNotMatch(html, /data-code-language="json"/)
  assert.doesNotMatch(html, /task-tool-output-format-actions/)
  assert.ok(html.length < 35_000, 'only the bounded source window reaches the DOM')
})

test('oversized Markdown and plain logs use the same low-cost tool window', () => {
  const hugeMarkdown = '## log title\n' + '| field | value |\n| --- | --- |\n'
    + 'abc\n'.repeat(30_000) + 'tail-marker'
  const html = renderToStaticMarkup(createElement(ToolOutputContent, { text: hugeMarkdown }))
  assert.match(html, /data-view="window"/)
  assert.doesNotMatch(html, /tail-marker/)
  assert.doesNotMatch(html, /markdown-table-scroll/)
  assert.ok(html.length < 35_000)
})
