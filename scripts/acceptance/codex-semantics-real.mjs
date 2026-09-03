import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

const baseUrl = (process.env.AGENT_LENS_ACCEPTANCE_URL || 'http://127.0.0.1:56789').replace(/\/$/, '')
const path = process.env.AGENT_LENS_ACCEPTANCE_PATH || '/review?range=all&status=all'
const outputDir = resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/task-center')
const expectedLatestTitle = process.env.AGENT_LENS_ACCEPTANCE_LATEST_TITLE || 'Alpha3 原生标题 B'
const expectedOlderTitle = process.env.AGENT_LENS_ACCEPTANCE_OLDER_TITLE || 'Alpha3 原生标题 A'

function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }

async function waitFor(win, expression, label, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await win.webContents.executeJavaScript(expression).catch(() => null)
    if (value) return value
    await delay(100)
  }
  throw new Error(`${label} 超过 ${Math.round(timeoutMs / 1000)} 秒`)
}

function createWindow() {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
}

app.commandLine.appendSwitch('disable-gpu')
await app.whenReady()
await mkdir(outputDir, { recursive: true })

const report = {
  kind: 'codex-semantics-real',
  startedAt: new Date().toISOString(),
  ok: false,
  errors: [],
}

const win = createWindow()
try {
  await win.loadURL(`${baseUrl}${path}`)
  await waitFor(win, `(() => {
    const titles = [...document.querySelectorAll('.session-item-title')]
    const header = document.querySelector('.task-header-title')
    const assistant = document.querySelector('[data-task-message-role="assistant"] .task-message-bubble')
    return titles.length >= 2 && header && assistant
  })()`, '等待 Codex Task Center 语义页面')
  await delay(250)

  const value = await win.webContents.executeJavaScript(`(() => {
    const text = element => (element?.textContent || '').trim()
    const sessionTitles = [...document.querySelectorAll('.session-item-title')].map(text).slice(0, 2)
    const headerTitle = text(document.querySelector('.task-header-title'))
    const assistantTexts = [...document.querySelectorAll('[data-task-message-role="assistant"] .task-message-bubble')].map(text)
    const bodyText = document.body.innerText || ''
    const processGroups = [...document.querySelectorAll('details.task-thinking')].filter(item => text(item.querySelector('.task-thinking-label')) === '思考过程')
    const toolRows = [...document.querySelectorAll('[data-tool-fact="true"] .task-tool-row')]
    const trigger = toolRows[0]
    if (trigger instanceof HTMLElement) trigger.click()
    return {
      sessionTitles,
      headerTitle,
      assistantTexts,
      machineMetadataVisible: /<oai-mem-citation>|citation_entries|rollout_ids/i.test(bodyText),
      processGroupCount: processGroups.length,
      openProcessGroupCount: processGroups.filter(item => item.open).length,
      toolCount: toolRows.length,
      clickedTool: trigger instanceof HTMLElement,
    }
  })()`)

  await delay(150)
  const inspectorOpen = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.inspector-panel[role="dialog"]'))`)
  if (inspectorOpen) {
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await delay(80)
  }

  report.value = { ...value, inspectorOpen }
  const errors = report.errors
  if (value.sessionTitles[0] !== expectedLatestTitle) errors.push(`列表首条原生标题错误：${value.sessionTitles[0] ?? '<missing>'}`)
  if (value.sessionTitles[1] !== expectedOlderTitle) errors.push(`列表第二条原生标题错误：${value.sessionTitles[1] ?? '<missing>'}`)
  if (value.headerTitle !== expectedLatestTitle) errors.push(`详情标题与列表标题不一致：${value.headerTitle || '<missing>'}`)
  if (!value.assistantTexts.some(item => item.includes('好的，先跑测试'))) errors.push('未找到期望的 Assistant 可见正文')
  if (value.machineMetadataVisible) errors.push('Chromium 可见正文仍泄漏 Codex machine metadata')
  if (value.processGroupCount < 1) errors.push('未渲染聚合思考过程')
  if (value.openProcessGroupCount !== value.processGroupCount) errors.push(`聚合思考过程未默认展开：${value.openProcessGroupCount}/${value.processGroupCount}`)
  if (value.toolCount < 1) errors.push('聚合思考过程展开后仍没有具体 Tool Row')
  if (!value.clickedTool || !inspectorOpen) errors.push('Tool Row 未能打开 Inspector')
  report.ok = errors.length === 0
} catch (error) {
  report.errors.push(error instanceof Error ? error.stack || error.message : String(error))
  report.ok = false
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(outputDir, 'codex-semantics-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  if (!win.isDestroyed()) win.destroy()
  app.exit(report.ok ? 0 : 1)
}
