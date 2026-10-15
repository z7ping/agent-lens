import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

test('Runtime UI 请求统一由无障碍 Dialog 处理，而非局部 div 伪弹窗', () => {
  const live = source('./LiveTaskPage.tsx')
  const prompt = source('./LiveExtensionPrompt.tsx')
  assert.match(live, /import \{ LiveExtensionPrompt \} from '\.\/LiveExtensionPrompt'/)
  assert.doesNotMatch(live, /function LiveExtensionPrompt\(/)
  assert.match(prompt, /return <Dialog/)
  assert.match(prompt, /closeDisabled=\{pending\}/)
  assert.match(prompt, /closeOnBackdrop=\{false\}/)
  assert.match(prompt, /request\.method === 'confirm' \? \{ confirmed: false \} : \{ cancelled: true \}/)
})

test('Task Center 搜索框仅有一个领域样式所有者', () => {
  const task = source('../task-center.css')
  const shell = source('../components/workspace-sidebar.css')
  const interactions = source('../components/workspace-sidebar-interactions.css')
  assert.match(task, /\.task-center-search-input\.ui-field\s*\{/)
  assert.doesNotMatch(shell, /\.task-center-search-input\.ui-field\s*\{/)
  assert.doesNotMatch(interactions, /\.task-center-search-input\.ui-field\s*\{/)
})

test('工具排序使用原生按钮且保留列标题和 aria-sort 语义', () => {
  const page = source('./ToolsPage.tsx')
  const css = source('../tools.css')
  assert.match(page, /<th scope="col" aria-sort=\{ariaSort\('callCount'\)\}><button type="button" className="tool-table-sort"/)
  assert.doesNotMatch(page, /<th tabIndex=\{0\} role="button"/)
  assert.match(css, /\.tool-table \.tool-table-sort:focus-visible/)
})
