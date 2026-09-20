import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const review = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
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

test('Evidence sourceLocator.path 复用统一本地资源引用并保留 source kind', () => {
  assert.match(review, /item\.sourceLocator\?\.path/)
  assert.match(review, /item\.sourceLocator\.kind === 'file' \? 'file' : 'path'/)
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
