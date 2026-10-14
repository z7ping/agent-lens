import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { codeLanguageFromContent, normalizedCodeLanguage } from './code-language'
import { CopyableCodeBlock } from './CopyableCodeBlock'
import { MarkdownContent } from './MarkdownContent'

test('normalize known languages and do not guess arbitrary unknown names', () => {
  assert.equal(normalizedCodeLanguage('language-ts'), 'typescript')
  assert.equal(normalizedCodeLanguage('JAVA'), 'java')
  assert.equal(normalizedCodeLanguage('sh'), 'bash')
  assert.equal(normalizedCodeLanguage('ps1'), 'powershell')
  assert.equal(normalizedCodeLanguage('unknown'), undefined)
})

test('only complete JSON payloads are inferred, native Shell is explicitly typed', () => {
  assert.equal(codeLanguageFromContent('{"command":"pwd"}'), 'json')
  assert.equal(codeLanguageFromContent('[{"ok":true}]'), 'json')
  assert.equal(codeLanguageFromContent('Error [MCP_READ_ONLY]: aborted'), undefined)
  assert.equal(codeLanguageFromContent('pwd', 'bash'), 'bash')
  assert.equal(codeLanguageFromContent('{"incomplete":', 'bash'), 'bash')
})

test('Prism renders Java / SQL tokens as safe React nodes without altering copy value', () => {
  const text = 'public class Example { String name = "demo"; }'
  const html = renderToStaticMarkup(createElement(CopyableCodeBlock, { language: 'java', copyValue: text, children: text }))
  assert.match(html, /data-code-language="java"/)
  assert.match(html, /class="language-java"/)
  assert.match(html, /token-keyword/)
  assert.match(html, /public/)
  const sql = renderToStaticMarkup(createElement(CopyableCodeBlock, { language: 'sql', children: 'SELECT id FROM users' }))
  assert.match(sql, /data-code-language="sql"/)
  assert.match(sql, /token-keyword/)
  const escaped = renderToStaticMarkup(createElement(CopyableCodeBlock, { language: 'markup', children: '<script>alert("x")</script>' }))
  assert.doesNotMatch(escaped, /<script>/)
  assert.match(escaped, /&lt;/)
})

test('Markdown code fences carry their language to the shared copy block', () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, { text: '```typescript\nconst x: number = 42\n```' }))
  assert.match(html, /data-code-language="typescript"/)
  assert.match(html, /token-keyword/)
})

test('unknown code remains raw and long logs do not trigger Prism tokenization', () => {
  const text = 'unstructured diagnostic output'
  const raw = renderToStaticMarkup(createElement(CopyableCodeBlock, { language: 'not-a-language', children: text }))
  assert.doesNotMatch(raw, /data-code-language=/)
  assert.match(raw, /unstructured diagnostic output/)
  const long = 'SELECT '.repeat(15_000)
  const output = renderToStaticMarkup(createElement(CopyableCodeBlock, { language: 'sql', children: long }))
  assert.doesNotMatch(output, /data-code-language=/)
})
