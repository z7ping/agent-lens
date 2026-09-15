import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const agents = readFileSync(new URL('./features/AgentsPage.tsx', import.meta.url), 'utf8')
const previewDialog = readFileSync(new URL('./components/AgentManagedFilesDialog.tsx', import.meta.url), 'utf8')
const localPathActions = readFileSync(new URL('./components/LocalPathActions.tsx', import.meta.url), 'utf8')
const backup = readFileSync(new URL('./features/BackupPage.tsx', import.meta.url), 'utf8')
const piLive = readFileSync(new URL('./features/PiLivePage.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./features/ReviewPage.tsx', import.meta.url), 'utf8')
const overlay = readFileSync(new URL('./components/ui/Overlay.tsx', import.meta.url), 'utf8')
const overlayCss = readFileSync(new URL('./components/ui/overlay.css', import.meta.url), 'utf8')
const agentsCss = readFileSync(new URL('./agents.css', import.meta.url), 'utf8')
const markdownThemes = readFileSync(new URL('./components/markdown-themes.css', import.meta.url), 'utf8')

test('智能体资产列表统一通过受管文件 Dialog 打开绑定与目录预览', () => {
  assert.match(agents, /t\('managedFiles\.preview'\)/)
  assert.match(agents, /root="binding"/)
  assert.match(agents, /bindingId=\{previewAsset\.binding\.id\}/)
  assert.match(agents, /<AgentManagedFilesDialog/)
  assert.doesNotMatch(agents, /AgentManagedFilesDrawer/)
})

test('单文件与目录型资产复用统一 Dialog 并保留安全状态', () => {
  assert.match(previewDialog, /<Dialog/)
  assert.doesNotMatch(previewDialog, /<Drawer/)
  assert.match(previewDialog, /headerActions=\{headerActions\}/)
  assert.match(previewDialog, /previewStatus === 'metadata-only'/)
  assert.match(previewDialog, /preview\?\.redacted/)
  assert.match(previewDialog, /bindingId/)
})

test('统一 Dialog 继续持有 Escape 与焦点恢复契约', () => {
  assert.match(overlay, /event\.key === 'Escape'/)
  assert.match(overlay, /previous\?\.isConnected/)
  assert.match(overlay, /previous\.focus/)
})

test('本地路径统一复用轻量打开与复制动作', () => {
  assert.match(localPathActions, /<IconButton/)
  assert.match(localPathActions, /name=\{openState === 'opened' \|\| openState === 'revealed' \? 'check' : 'folder-open'\}/)
  assert.match(localPathActions, /name=\{copied \? 'check' : 'copy'\}/)
  assert.match(agents, /<LocalPathActions/)
  assert.match(previewDialog, /<LocalPathActions/)
  assert.match(backup, /<LocalPathActions/)
  assert.match(piLive, /<LocalPathActions/)
  assert.match(review, /<LocalPathActions/)
  assert.doesNotMatch(agents, /className="copy-link"/)
})

test('Markdown 资产使用统一宽 Dialog 并把阅读控制收进 Header', () => {
  assert.match(previewDialog, /function isMarkdownFile/)
  assert.match(previewDialog, /className=\{\`agent-managed-files-dialog/)
  assert.match(previewDialog, /headerActions=\{headerActions\}/)
  assert.match(previewDialog, /size="xlarge"/)
  assert.match(previewDialog, /<MarkdownContent text=\{preview\.content\}[^>]*frontmatter/)
  assert.match(previewDialog, /previewView === 'rendered'/)
  assert.match(previewDialog, /previewView === 'source'/)
  assert.match(previewDialog, /setPreviewView\(isMarkdownFile\(result\.name\) \? 'rendered' : 'source'\)/)
  assert.doesNotMatch(previewDialog, /managed-file-preview-head/)
  assert.match(overlay, /headerActions\?: ReactNode/)
  assert.match(overlayCss, /\.ui-overlay-header-actions/)
  assert.match(overlayCss, /\.ui-overlay-dialog\.is-size-small \.ui-overlay-panel \{ width: min\(100%, 480px\); \}/)
  assert.match(overlayCss, /\.ui-overlay-dialog\.is-size-medium \.ui-overlay-panel \{ width: min\(100%, 620px\); \}/)
  assert.match(overlayCss, /\.ui-overlay-dialog\.is-size-large \.ui-overlay-panel \{ width: min\(100%, 860px\); \}/)
  assert.match(overlayCss, /\.ui-overlay-dialog\.is-size-xlarge \.ui-overlay-panel \{ width: min\(100%, 1180px\); \}/)
  const managedDialogPanelRule = agentsCss.match(/\.agent-managed-files-dialog \.ui-overlay-panel \{([^}]*)\}/)?.[1] ?? ''
  assert.doesNotMatch(managedDialogPanelRule, /\bwidth:/)
  assert.match(agentsCss, /grid-template-columns:\s*minmax\(240px, 280px\) minmax\(0, 1fr\)/)
})

test('Markdown 文档皮肤默认使用 Next Helvetica 且被限制在预览内容作用域', () => {
  assert.match(previewDialog, /useSyncExternalStore\(subscribeMarkdownTheme, readMarkdownTheme, readMarkdownTheme\)/)
  assert.match(previewDialog, /<SelectMenu[\s\S]*?managed-file-theme-select/)
  assert.match(previewDialog, /<MarkdownContent[^>]*theme=\{markdownTheme\}/)
  assert.match(previewDialog, /customMarkdownThemes\.map/)
  assert.match(markdownThemes, /\.markdown\[data-markdown-theme='next-helvetica'\]/)
  assert.match(markdownThemes, /\.markdown\[data-markdown-theme\^='custom:'\]/)
  assert.doesNotMatch(markdownThemes, /(^|[},]\s*)(?:html|body|:root)(?:\s|,|\{)/m)
  assert.doesNotMatch(markdownThemes, /!important/)
})

test('绑定目标判定不再把任意 400 当成目录', () => {
  assert.match(previewDialog, /managedFileStatus\(error\) === 409/)
  assert.doesNotMatch(previewDialog, /managedFileStatus\(error\) === 400/)
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
  assert.match(previewDialog, /entry\.name\.toLowerCase\(\) === 'skill\.md'/)
  assert.match(previewDialog, /void selectFile\(skillEntry\)/)
})

test('文件预览使用请求序号避免旧响应覆盖新选择', () => {
  assert.match(previewDialog, /const previewRequestRef = useRef\(0\)/)
  assert.match(previewDialog, /previewRequestRef\.current !== request/)
})

test('目录内文件统一由后端裁决正文或元信息状态', () => {
  assert.doesNotMatch(previewDialog, /if \(!entry\.previewable\) return/)
  assert.match(previewDialog, /model\.managedAssetFile/)
})

test('目录错误与文件预览错误互不覆盖', () => {
  assert.match(previewDialog, /directoryError/)
  assert.match(previewDialog, /previewError/)
  assert.doesNotMatch(previewDialog, /const \[error, setError\]/)
})
