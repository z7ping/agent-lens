import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

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

test('复制按钮使用独立工具栏，不覆盖首行、长行或滚动正文', () => {
  const toolbar = componentSource.indexOf('className="code-block-copy-toolbar"')
  const copyButton = componentSource.indexOf('className="code-block-copy"')
  const pre = componentSource.indexOf('<pre {...preProps}>')
  assert.ok(toolbar >= 0 && copyButton > toolbar && pre > copyButton)
  assert.match(codeBlockStyles, /\.copyable-code-block \{[^}]*display: flex;[^}]*flex-direction: column;/)
  assert.match(codeBlockStyles, /\.code-block-copy-toolbar \{[^}]*display: flex;[^}]*justify-content: flex-end;/)
  assert.match(codeBlockStyles, /\.code-block-copy \{\s*position: static;/)
  assert.doesNotMatch(codeBlockStyles, /\.code-block-copy \{\s*position: absolute;/)
  assert.doesNotMatch(codeBlockStyles, /padding-right: (?:70|62)px/)
})
