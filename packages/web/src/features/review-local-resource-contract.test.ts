import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const review = [
  'review-session-format.ts', 'ReviewEvidenceInspector.tsx', 'ReviewRoundPresentation.tsx',
  'review-reader-position.ts', 'use-review-session.ts', 'ReviewPage.tsx',
].map(file => readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')).join('\n')
const resource = readFileSync(new URL('../components/LocalResourceReference.tsx', import.meta.url), 'utf8')
const toolRow = readFileSync(new URL('./TaskToolRow.tsx', import.meta.url), 'utf8')

test('Review 工具详情把 read/edit 文件与 search 目录接入统一本地资源引用', () => {
  assert.match(review, /function toolLocalResource/)
  assert.match(review, /kind === 'read' \|\| kind === 'edit'/)
  assert.match(review, /kind: 'file', placement: 'primary'/)
  assert.match(review, /kind === 'search'/)
  assert.match(review, /kind: 'directory', placement: 'secondary'/)
  assert.match(review, /<LocalResourceReference value=\{resource\.value\} kind=\{resource\.kind\}/)
})

test('Evidence 与 Raw locator path 复用统一本地资源引用并保留 source kind', () => {
  assert.match(review, /item\.sourceLocator\?\.path/)
  assert.match(review, /item\.sourceLocator\.kind === 'file' \? 'file' : 'path'/)
  assert.match(review, /record\.locator\.path/)
  assert.match(review, /record\.locator\.kind === 'file' \? 'file' : 'path'/)
  assert.match(review, /presentation="inline"/)
})

test('统一本地资源引用复用 Markdown 文件预览与 Host 路径动作', () => {
  assert.match(resource, /parseLocalFileTarget\(value\)/)
  assert.match(resource, /<LocalFileLink href=\{value\}/)
  assert.match(resource, /<LocalPathActions path=\{target\.path\} onOpen=\{clientModel\.openHostPath\}/)
})

test('TaskToolRow 仍保持单一 button 交互，不在按钮内部嵌套本地资源按钮', () => {
  assert.doesNotMatch(toolRow, /LocalResourceReference/)
  assert.doesNotMatch(toolRow, /LocalPathActions/)
})

test('证据 Inspector 详情优先展示 SourceRecord 原文，Markdown 默认渲染且不使用截断摘要', () => {
  const inspector = readFileSync(new URL('./ReviewEvidenceInspector.tsx', import.meta.url), 'utf8')
  const styles = readFileSync(new URL('../review.css', import.meta.url), 'utf8')
  assert.match(inspector, /if \(tab !== 'detail' && tab !== 'raw'\) return/)
  assert.match(inspector, /rawRecords\.map\(record => <div className="inspector-source-entry"/)
  assert.match(inspector, /<OriginalEvidenceValue value=\{record\.payload\}\/>/)
  assert.match(inspector, /node\.type === 'message' \? node\.text : node\.payload/)
  assert.match(inspector, /<MarkdownContent className="inspector-original-markdown" text=\{content\}\/>/)
  assert.match(inspector, /<CopyableCodeBlock className="raw-json" copyValue=\{content\} language=\{isText \? undefined : 'json'\}/)
  assert.doesNotMatch(inspector, /const detailSummary =|<h3 className="section-label">\{t\('local\.event\.summary'\)\}/)
  assert.doesNotMatch(inspector, /brief\(node\.text, 280\)/)
  assert.match(styles, /\.review-inspector-overlay \.inspector-original-value \.raw-json \{ max-height: none;/)
})
