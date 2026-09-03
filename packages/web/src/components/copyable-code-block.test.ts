import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const componentSource = readFileSync(new URL('./CopyableCodeBlock.tsx', import.meta.url), 'utf8')
const markdownSource = readFileSync(new URL('./MarkdownContent.tsx', import.meta.url), 'utf8')

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.tsx') ? [path] : []
  })
}

test('所有代码块都通过统一复制组件渲染', () => {
  const directPreOwners = sourceFiles(sourceRoot)
    .filter(path => !path.endsWith('/CopyableCodeBlock.tsx'))
    .filter(path => /<pre(?:\s|>)/.test(readFileSync(path, 'utf8')))

  assert.deepEqual(directPreOwners, [])
  assert.match(markdownSource, /pre: \(\{ node: _node, \.\.\.props \}\) => <CopyableCodeBlock \{\.\.\.props\}\/>/)
})

test('复制按钮包含成功、失败反馈和可访问名称', () => {
  assert.match(componentSource, /state === 'copied' \? '已复制' : state === 'error' \? '复制失败' : '复制'/)
  assert.match(componentSource, /aria-label=\{`\$\{label\}代码块`\}/)
  assert.match(componentSource, /window\.setTimeout\(\(\) => setState\('idle'\), 1800\)/)
})
