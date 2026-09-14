import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const agents = readFileSync(new URL('./features/AgentsPage.tsx', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('./components/AgentManagedFilesDrawer.tsx', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('./components/ui/Overlay.tsx', import.meta.url), 'utf8')

test('智能体资产列表通过现有受管文件 Drawer 打开绑定预览', () => {
  assert.match(agents, /t\('managedFiles\.preview'\)/)
  assert.match(agents, /root="binding"/)
  assert.match(agents, /bindingId=\{previewAsset\.binding\.id\}/)
  assert.match(agents, /<AgentManagedFilesDrawer/)
  assert.doesNotMatch(agents, /<Dialog[^>]*asset/i)
})

test('资产绑定预览复用统一 Drawer 并保留安全状态', () => {
  assert.match(drawer, /<Drawer/)
  assert.match(drawer, /previewStatus === 'metadata-only'/)
  assert.match(drawer, /preview\?\.redacted/)
  assert.match(drawer, /bindingId/)
})

test('统一 Drawer 继续持有 Escape 与焦点恢复契约', () => {
  assert.match(overlay, /event\.key === 'Escape'/)
  assert.match(overlay, /previous\?\.isConnected/)
  assert.match(overlay, /previous\.focus/)
})
