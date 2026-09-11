import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve('packages/web/src')
const OFFICIAL_BASELINE = resolve(ROOT, 'i18n/official-zh-CN.ts')
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

function ignored(path) {
  return path === OFFICIAL_BASELINE
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /\.spec\.[cm]?[jt]sx?$/.test(path)
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !ignored(path)) files.push(path)
  }
  return files
}

function candidateText(node, sourceFile) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
    || node.kind === ts.SyntaxKind.JsxText) {
    return node.getText(sourceFile)
  }
  return ''
}

function location(sourceFile, node) {
  const start = node.getStart(sourceFile)
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start)
  return { line: line + 1, column: character + 1 }
}

const violations = []
for (const path of await collect(ROOT)) {
  const source = await readFile(path, 'utf8')
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)

  const visit = node => {
    const text = candidateText(node, file)
    if (text && CJK.test(text)) {
      const { line, column } = location(file, node)
      violations.push({
        path: relative(process.cwd(), path).replaceAll('\\\\', '/'),
        line,
        column,
        text: text.replace(/\s+/g, ' ').trim().slice(0, 140),
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
}

if (violations.length) {
  console.error('Web i18n gate failed: production Chinese copy must live in packages/web/src/i18n/official-zh-CN.ts')
  for (const item of violations) {
    console.error(`- ${item.path}:${item.line}:${item.column} ${JSON.stringify(item.text)}`)
  }
  process.exit(1)
}

console.log('Web i18n gate passed: no production Chinese copy outside the official zh-CN baseline.')
