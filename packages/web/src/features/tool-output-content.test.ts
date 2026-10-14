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
})

test('the original output remains the default and copyable even for Markdown tables', () => {
  const text = '| col | val |\n| --- | --- |\n| 1 | 2 |'
  const html = renderToStaticMarkup(createElement(ToolOutputContent, { text }))
  assert.match(html, /data-view="original"/)
  assert.match(html, /task-tool-output-format-actions/)
  assert.match(html, /copyable-code-block/)
  assert.match(html, /\| --- \| --- \|/)
})
