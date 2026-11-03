import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CopyableCodeBlock } from './CopyableCodeBlock'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const componentSource = readFileSync(new URL('./CopyableCodeBlock.tsx', import.meta.url), 'utf8')
const markdownSource = readFileSync(new URL('./MarkdownContent.tsx', import.meta.url), 'utf8')
const codeBlockStyles = readFileSync(new URL('./copyable-code-block.css', import.meta.url), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('所有代码块都通过统一复制组件渲染', () => {
  const directPreOwners = sourceFiles(sourceRoot)
    .filter(path => !path.endsWith('CopyableCodeBlock.tsx') && !path.endsWith('TaskMessage.tsx'))
    .filter(path => /<pre(?:\s|>)/.test(readFileSync(path, 'utf8')))

  assert.deepEqual(directPreOwners, [])
  assert.match(readFileSync(new URL('../features/TaskMessage.tsx', import.meta.url), 'utf8'), /<pre className="task-message-failure-raw">\{text\}<\/pre>[\s\S]*?className="task-message-failure-copy"/)
  assert.match(markdownSource, /pre: \(\{ node: _node, \.\.\.props \}\) => <CopyableCodeBlock \{\.\.\.props\}\/>/)
})

test('复制按钮包含成功、失败反馈和可访问名称', () => {
  assert.match(componentSource, /state === 'copied' \? t\('codeBlock\.copied'\) : state === 'error' \? t\('codeBlock\.failed'\) : t\('codeBlock\.copy'\)/)
  assert.match(componentSource, /aria-label=\{t\('codeBlock\.aria', \{ label \}\)\}/)
  assert.match(componentSource, /window\.setTimeout\(\(\) => setState\('idle'\), 1800\)/)
})

test('复制图标在代码块内部保留独立行，不覆盖首行与滚动内容', () => {
  const toolbar = componentSource.indexOf('className="code-block-copy-toolbar"')
  const button = componentSource.indexOf('<IconButton')
  const pre = componentSource.indexOf('<pre {...preProps}>')
  const code = componentSource.indexOf('highlighted ? <code')
  assert.ok(toolbar >= 0 && button > toolbar && pre > button && code > pre)
  assert.match(componentSource, /import \{ IconButton, UiIcon \} from '\.\/ui'/)
  assert.match(componentSource, /size="small"/)
  assert.match(componentSource, /title=\{label\}/)
  assert.match(codeBlockStyles, /\.copyable-code-block \{[^}]*display: flex;[^}]*flex-direction: column;/)
  assert.match(codeBlockStyles, /\.code-block-copy-toolbar \{[^}]*display: flex;[^}]*min-height: 34px;/)
  assert.match(codeBlockStyles, /\.copyable-code-block > pre \{[^}]*overflow: auto;[^}]*border: 0;/)
  assert.match(codeBlockStyles, /\.code-block-copy\.ui-icon-button \{[^}]*opacity: 0;/)
  assert.match(codeBlockStyles, /:focus-within/)
  assert.match(codeBlockStyles, /@media \(hover: none\), \(pointer: coarse\)/)
  assert.doesNotMatch(codeBlockStyles, /position: (?:sticky|absolute);/)
  assert.doesNotMatch(codeBlockStyles, /pre::before/)
  assert.doesNotMatch(codeBlockStyles, /padding-right: (?:70|62)px/)
})

test('代码块只渲染一个 pre，复制图标使用共享 Tooltip，不改动原始复制内容', () => {
  const html = renderToStaticMarkup(createElement(CopyableCodeBlock, {
    copyValue: 'POST /rpc/v2/busApp/userInfo',
    children: createElement('code', null, 'POST /rpc/v2/busApp/userInfo'),
  }))
  assert.equal((html.match(/<pre\b/g) ?? []).length, 1)
  assert.match(html, /<span class="code-block-copy-toolbar"><button[^>]*class="ui-icon-button is-small is-default code-block-copy"/)
  assert.match(html, /data-ui-tooltip="/)
  assert.doesNotMatch(html, /\stitle="/)
  assert.match(html, /<pre[^>]*><code>POST \/rpc\/v2\/busApp\/userInfo<\/code><\/pre>/)
  assert.equal((html.match(/POST \/rpc\/v2\/busApp\/userInfo/g) ?? []).length, 1)
})
