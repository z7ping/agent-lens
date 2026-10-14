import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

const baseUrl = (process.env.AGENT_LENS_ACCEPTANCE_URL || 'http://127.0.0.1:56789').replace(/\/$/, '')
const path = process.env.AGENT_LENS_ACCEPTANCE_PATH || '/review?range=all&status=all'
const outputDir = resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/task-center')
// Source / Review API 保留 Codex 原生 thread_name；Task Center 的用户任务标题则来自
// authoritative event_msg.user_message。两层语义在 workflow 与这里分别验收。
const expectedTaskTitle = process.env.AGENT_LENS_ACCEPTANCE_TASK_TITLE || '运行测试并修复'

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

  // Process is intentionally folded. Exercise the actual disclosure before
  // asserting Tool rows and the Inspector action inside an individual Tool.
  const initial = await win.webContents.executeJavaScript(`(() => {
    const groups = [...document.querySelectorAll('details.task-thinking.task-review-process')]
    const closed = groups.filter(group => !group.open).length
    for (const group of groups) if (!group.open) group.querySelector(':scope > summary')?.click()
    return { groupCount: groups.length, closedCount: closed }
  })()`)
  await waitFor(win, `(() => document.querySelectorAll('[data-tool-fact="true"] .task-tool-row').length >= 1)()`, '等待展开后的 Codex Tool 行')

  const value = await win.webContents.executeJavaScript(`(async () => {
    const text = element => (element?.textContent || '').trim()
    const sessionTitles = [...document.querySelectorAll('.session-item-title')].map(text).slice(0, 2)
    const headerTitle = text(document.querySelector('.task-header-title'))
    const assistantTexts = [...document.querySelectorAll('[data-task-message-role="assistant"] .task-message-bubble')].map(text)
    const bodyText = document.body.innerText || ''
    const processGroups = [...document.querySelectorAll('details.task-thinking.task-review-process')]
    const calls = [...document.querySelectorAll('details.task-tool-call[data-tool-fact="true"]')]
    const initiallyClosedToolCount = calls.filter(call => !call.open).length
    const call = calls[0]
    if (call && !call.open) call.querySelector(':scope > summary')?.click()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const hasInput = call?.querySelectorAll('[data-tool-section="input"]').length === 1
    const hasOutput = call?.querySelectorAll('[data-tool-section="output"]').length === 1
    const trigger = call?.querySelector('button.task-tool-inspect')
    if (trigger instanceof HTMLElement) trigger.click()
    return {
      sessionTitles, headerTitle, assistantTexts,
      machineMetadataVisible: /<oai-mem-citation>|citation_entries|rollout_ids/i.test(bodyText),
      processGroupCount: processGroups.length,
      openProcessGroupCount: processGroups.filter(item => item.open).length,
      toolCount: calls.length,
      initiallyClosedToolCount,
      hasInput, hasOutput,
      clickedTool: trigger instanceof HTMLElement,
    }
  })()`)
  await delay(150)
  const inspectorOpen = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.review-inspector-overlay .ui-drawer[role="dialog"]'))`)
  if (inspectorOpen) {
    await win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`)
    await delay(80)
  }

  report.value = { ...value, inspectorOpen }
  const errors = report.errors
  if (value.sessionTitles[0] !== expectedTaskTitle) errors.push(`列表首条未使用结构化真实用户任务标题：${value.sessionTitles[0] ?? '<missing>'}`)
  if (value.sessionTitles[1] !== expectedTaskTitle) errors.push(`列表第二条未使用结构化真实用户任务标题：${value.sessionTitles[1] ?? '<missing>'}`)
  if (value.headerTitle !== expectedTaskTitle) errors.push(`详情标题未与 Task Center 用户任务标题一致：${value.headerTitle || '<missing>'}`)
  if (!value.assistantTexts.some(item => item.includes('好的，先跑测试'))) errors.push('未找到期望的 Assistant 可见正文')
  if (value.machineMetadataVisible) errors.push('Chromium 可见正文仍泄漏 Codex machine metadata')
  if (value.processGroupCount < 1) errors.push('未渲染聚合执行过程')
  if (initial.closedCount !== initial.groupCount) errors.push(`聚合执行过程应默认折叠：${initial.closedCount}/${initial.groupCount}`)
  if (value.openProcessGroupCount !== value.processGroupCount) errors.push('点击后聚合执行过程未展开')
  if (value.toolCount < 1) errors.push('聚合执行过程展开后仍没有具体 Tool Row')
  if (value.initiallyClosedToolCount !== value.toolCount) errors.push(`Tool Call 应默认折叠：${value.initiallyClosedToolCount}/${value.toolCount}`)
  if (!value.hasInput || !value.hasOutput) errors.push('Tool 展开后未分别展示入参和出参')
  if (!value.clickedTool || !inspectorOpen) errors.push('Tool 明确操作按钮未能打开 Inspector')
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
