import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const agents = readFileSync(new URL('./features/AgentsPage.tsx', import.meta.url), 'utf8')
const drawer = readFileSync(new URL('./components/AgentManagedFilesDrawer.tsx', import.meta.url), 'utf8')
const localPathActions = readFileSync(new URL('./components/LocalPathActions.tsx', import.meta.url), 'utf8')
const backup = readFileSync(new URL('./features/BackupPage.tsx', import.meta.url), 'utf8')
const piLive = readFileSync(new URL('./features/PiLivePage.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./features/ReviewPage.tsx', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('./components/ui/Overlay.tsx', import.meta.url), 'utf8')
const markdownThemes = readFileSync(new URL('./components/markdown-themes.css', import.meta.url), 'utf8')

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

test('本地路径统一复用轻量打开与复制动作', () => {
  assert.match(localPathActions, /<IconButton/)
  assert.match(localPathActions, /name=\{openState === 'opened' \|\| openState === 'revealed' \? 'check' : 'folder-open'\}/)
  assert.match(localPathActions, /name=\{copied \? 'check' : 'copy'\}/)
  assert.match(agents, /<LocalPathActions/)
  assert.match(drawer, /<LocalPathActions/)
  assert.match(backup, /<LocalPathActions/)
  assert.match(piLive, /<LocalPathActions/)
  assert.match(review, /<LocalPathActions/)
  assert.doesNotMatch(agents, /className="copy-link"/)
})

test('Markdown 资产使用宽文档模式并支持渲染与源码切换', () => {
  assert.match(drawer, /function isMarkdownFile/)
  assert.match(drawer, /documentPreview = previewOnly && isMarkdownFile/)
  assert.match(drawer, /<Dialog/)
  assert.match(drawer, /<MarkdownContent text=\{preview\.content\}/)
  assert.match(drawer, /previewView === 'rendered'/)
  assert.match(drawer, /previewView === 'source'/)
  assert.match(drawer, /setPreviewView\(isMarkdownFile\(result\.name\) \? 'rendered' : 'source'\)/)
})

test('Markdown 文档皮肤默认使用 Next Helvetica 且被限制在预览内容作用域', () => {
  assert.match(drawer, /useState\(readMarkdownTheme\)/)
  assert.match(drawer, /<SelectMenu[\s\S]*?managed-file-theme-select/)
  assert.match(drawer, /<MarkdownContent[^>]*theme=\{markdownTheme\}/)
  assert.match(markdownThemes, /\.markdown\[data-markdown-theme='next-helvetica'\]/)
  assert.doesNotMatch(markdownThemes, /(^|[},]\s*)(?:html|body|:root)(?:\s|,|\{)/m)
  assert.doesNotMatch(markdownThemes, /!important/)
})

test('绑定目标判定不再把任意 400 当成目录', () => {
  assert.match(drawer, /managedFileStatus\(error\) === 409/)
  assert.doesNotMatch(drawer, /managedFileStatus\(error\) === 400/)
})

test('多绑定资产必须显式选择当前位置，路径动作与预览共享同一 binding', () => {
  assert.match(agents, /const pathBindings = asset\.bindings\.filter/)
  assert.match(agents, /selectedBindingId/)
  assert.match(agents, /<SelectMenu/)
  assert.match(agents, /value=\{binding\.id\}/)
  assert.match(agents, /onPreview\(asset, binding\)/)
  assert.doesNotMatch(agents, /asset\.bindings\.find\(item => item\.path\)/)
})

test('预览阻断原因与协议枚举保持同名', () => {
  const zhAgents = readFileSync(new URL('./i18n/zh-CN/agents.ts', import.meta.url), 'utf8')
  const enAgents = readFileSync(new URL('./i18n/en-US/agents.ts', import.meta.url), 'utf8')
  assert.match(zhAgents, /'too-large':/)
  assert.match(enAgents, /'too-large':/)
  assert.doesNotMatch(zhAgents, /tooLarge:/)
  assert.doesNotMatch(enAgents, /tooLarge:/)
})

test('目录型 Skill 自动落到 SKILL.md 预览', () => {
  assert.match(drawer, /entry\.name\.toLowerCase\(\) === 'skill\.md'/)
  assert.match(drawer, /void selectFile\(skillEntry\)/)
})

test('文件预览使用请求序号避免旧响应覆盖新选择', () => {
  assert.match(drawer, /const previewRequestRef = useRef\(0\)/)
  assert.match(drawer, /previewRequestRef\.current !== request/)
})

test('目录内文件统一由后端裁决正文或元信息状态', () => {
  assert.doesNotMatch(drawer, /if \(!entry\.previewable\) return/)
  assert.match(drawer, /model\.managedAssetFile/)
})

test('目录错误与文件预览错误互不覆盖', () => {
  assert.match(drawer, /directoryError/)
  assert.match(drawer, /previewError/)
  assert.doesNotMatch(drawer, /const \[error, setError\]/)
})
