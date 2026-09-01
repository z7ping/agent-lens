import { mkdir, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

const baseUrl = (process.env.AGENT_LENS_ACCEPTANCE_URL || 'http://127.0.0.1:56789').replace(/\/$/, '')
const path = process.env.AGENT_LENS_ACCEPTANCE_PATH || '/review'
const outputDir = resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/task-center')
const viewports = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
]
const themes = ['light', 'dark']
const report = {
  kind: 'task-center-desktop',
  baseUrl,
  path,
  startedAt: new Date().toISOString(),
  cases: [],
  inspectorReturn: null,
  switchStability: null,
  diagnostics: [],
  ok: true,
}

function fail(message) { throw new Error(message) }
function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)) }

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function webContentsAlive(win) {
  try { return Boolean(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) } catch { return false }
}
function ensureDebugger(win) {
  if (!webContentsAlive(win)) fail('Electron WebContents 已销毁，无法继续桌面验收')
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
}
function safeDetachDebugger(win) {
  try { if (webContentsAlive(win) && win.webContents.debugger.isAttached()) win.webContents.debugger.detach() } catch { /* teardown race */ }
}

async function applyViewport(win, viewport) {
  // 同时锁定真实 BrowserWindow content size，给 Windows hidden-window 截图提供可靠兜底。
  win.setContentSize(viewport.width, viewport.height)
  ensureDebugger(win)
  await withTimeout(win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: viewport.width,
    screenHeight: viewport.height,
    positionX: 0,
    positionY: 0,
    dontSetVisibleSize: false,
  }), 3_000, `设置 ${viewport.width}×${viewport.height} CSS viewport`)
  await withTimeout(win.webContents.debugger.sendCommand('Emulation.setVisibleSize', {
    width: viewport.width,
    height: viewport.height,
  }), 3_000, `设置 ${viewport.width}×${viewport.height} 可见区域`).catch(() => undefined)

  const expectedRail = viewport.width >= 1200 ? 316 : viewport.width >= 992 ? 286 : viewport.width >= 768 ? 252 : viewport.width
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const geometry = await withTimeout(win.webContents.executeJavaScript(`(() => {
      const page = document.querySelector('.task-center-page')
      const rail = document.querySelector('.task-center-rail')
      const pageRect = page?.getBoundingClientRect()
      const railRect = rail?.getBoundingClientRect()
      return { width: window.innerWidth, height: window.innerHeight, pageBottom: pageRect?.bottom || 0, railWidth: railRect?.width || 0 }
    })()`), 2_000, '等待 viewport 几何稳定')
    if (Math.abs(geometry.width - viewport.width) <= 1
      && Math.abs(geometry.height - viewport.height) <= 1
      && Math.abs(geometry.pageBottom - viewport.height) <= 2
      && Math.abs(geometry.railWidth - expectedRail) <= 2) return
    await delay(50)
  }
  fail(`${viewport.width}×${viewport.height} viewport 几何未稳定到原型基线`)
}

async function captureViewport(win, viewport, theme) {
  ensureDebugger(win)
  try {
    const result = await withTimeout(win.webContents.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    }), 10_000, `${viewport.width}×${viewport.height} ${theme} CDP 截图`)
    if (!result?.data) fail(`${viewport.width}×${viewport.height} ${theme} CDP 截图数据为空`)
    return Buffer.from(result.data, 'base64')
  } catch (error) {
    // Windows hosted runner 上 hidden BrowserWindow 的第二次 Page.captureScreenshot 偶发悬挂。
    // 先撤销卡住的 debugger session，再用已锁定 content size 的 Electron capturePage 兜底；
    // 几何/滚动/字号等验收仍来自真实 Renderer，兜底只影响证据截图传输。
    safeDetachDebugger(win)
    await delay(80)
    const image = await withTimeout(win.webContents.capturePage(), 8_000, `${viewport.width}×${viewport.height} ${theme} Electron 截图兜底`)
    const size = image.getSize()
    if (image.isEmpty() || Math.abs(size.width - viewport.width) > 2 || Math.abs(size.height - viewport.height) > 2) {
      throw new Error(`${viewport.width}×${viewport.height} ${theme} 截图失败；CDP=${error instanceof Error ? error.message : String(error)}；fallback=${size.width}×${size.height}`)
    }
    console.warn(`CDP 截图超时，已使用 Electron capturePage 兜底：${viewport.width}×${viewport.height} ${theme}`)
    return image.toPNG()
  }
}

async function persistReport() {
  const target = resolve(outputDir, 'task-center-desktop-report.json')
  const temporary = resolve(outputDir, `task-center-desktop-report.${process.pid}.tmp`)
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`)
  await rename(temporary, target)
}

async function waitForTaskCenter(win) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const ready = await withTimeout(win.webContents.executeJavaScript(`Boolean(document.querySelector('.task-center-page'))`), 2_000, '查询 .task-center-page').catch(() => false)
    if (ready) return
    await delay(200)
  }
  fail('20 秒内没有出现 .task-center-page；请确认 AgentLens 已运行且验收 URL 指向任务中心')
}

async function loadTaskCenter(win, label) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await withTimeout(win.loadURL(`${baseUrl}${path}`), 15_000, `${label} 页面加载`)
      await waitForTaskCenter(win)
      return
    } catch (error) {
      lastError = error
      if (attempt < 3) await delay(250 * attempt)
    }
  }
  throw lastError
}

async function inspect(win, viewport, theme) {
  await withTimeout(win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`), 3_000, `切换 ${theme} 主题`)
  await delay(80)

  const value = await withTimeout(win.webContents.executeJavaScript(`(() => {
    const pick = selector => document.querySelector(selector)
    const all = selector => [...document.querySelectorAll(selector)]
    const rect = element => element ? (() => { const r = element.getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height } })() : null
    const fontPx = element => element ? Number.parseFloat(getComputedStyle(element).fontSize) || 0 : 0
    const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none')
    const page = pick('.task-center-page')
    const toolbar = pick('.task-center-toolbar')
    const rail = pick('.task-center-rail')
    const railScroll = pick('.task-center-scroll')
    const main = pick('.task-center-main')
    const detailScroll = pick('.review-reader-pane') || pick('.pi-live-reader') || pick('.task-center-new')
    const pageStyle = page ? getComputedStyle(page) : null
    const railStyle = rail ? getComputedStyle(rail) : null
    const railScrollStyle = railScroll ? getComputedStyle(railScroll) : null
    const mainStyle = main ? getComputedStyle(main) : null
    const detailStyle = detailScroll ? getComputedStyle(detailScroll) : null
    const root = document.scrollingElement
    const toolGroups = all('[data-task-tool-group="true"]')
    const toolFacts = all('[data-tool-fact="true"]')
    const toolRows = all('[data-tool-fact="true"] .task-tool-row')
    const firstTool = toolRows[0] || null
    const firstToolAction = firstTool?.querySelector('.task-tool-action') || null
    const firstToolTarget = firstTool?.querySelector('.task-tool-target') || null
    const firstToolStatus = firstTool?.querySelector('.task-tool-status') || null
    const firstUserBubble = pick('[data-task-message-role="user"] .task-message-bubble')
    const firstAgentBubble = pick('[data-task-message-role="assistant"] .task-message-bubble')
    const firstThinkingContent = pick('.task-thinking-content')
    const liveOutputs = all('.task-tool-live-output pre')
    const errorOutputDetails = all('.task-tool-row-shell:has(.task-tool-row[data-status="error"]) .task-tool-output-details')
    const toolStyle = firstTool ? getComputedStyle(firstTool) : null
    const liveStyle = liveOutputs[0] ? getComputedStyle(liveOutputs[0]) : null
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      documentScrollWidth: root?.scrollWidth || 0,
      documentScrollHeight: root?.scrollHeight || 0,
      page: rect(page), toolbar: rect(toolbar), rail: rect(rail), railScroll: rect(railScroll), main: rect(main), detailScroll: rect(detailScroll),
      overflow: { page: pageStyle?.overflow || '', rail: railStyle?.overflow || '', railY: railScrollStyle?.overflowY || '', main: mainStyle?.overflow || '', detailY: detailStyle?.overflowY || '' },
      messageCount: all('.task-message-row').length,
      roundCount: all('[data-task-round-state]').length,
      thinkingCount: all('.task-thinking').length,
      toolCount: toolRows.length,
      taskButtonCount: all('.task-center-rail button.session-item').length,
      presentation: {
        toolGroupCount: toolGroups.length,
        closedToolGroupCount: toolGroups.filter(group => group.tagName === 'DETAILS' && !group.open).length,
        toolFactCount: toolFacts.length,
        hiddenToolFactCount: toolFacts.filter(item => !visible(item)).length,
        toolGridColumns: toolStyle?.gridTemplateColumns || '',
        toolGridColumnCount: toolStyle?.gridTemplateColumns?.trim().split(/\\s+/).filter(Boolean).length || 0,
        toolRow: rect(firstTool),
        toolRowClientWidth: firstTool?.clientWidth || 0,
        toolRowScrollWidth: firstTool?.scrollWidth || 0,
        toolFont: fontPx(firstTool),
        toolActionFont: fontPx(firstToolAction),
        toolTargetFont: fontPx(firstToolTarget),
        toolStatusFont: fontPx(firstToolStatus),
        userMessageFont: fontPx(firstUserBubble),
        agentMessageFont: fontPx(firstAgentBubble),
        thinkingFont: fontPx(firstThinkingContent),
        liveOutputCount: liveOutputs.length,
        liveOutputOverflowY: liveStyle?.overflowY || '',
        liveOutputMaxHeight: liveStyle?.maxHeight || '',
        errorOutputCount: errorOutputDetails.length,
        closedErrorOutputCount: errorOutputDetails.filter(item => !item.open).length,
      },
      theme: document.documentElement.dataset.theme || 'light',
      href: location.href,
      title: document.title,
    }
  })()`), 8_000, `读取 ${viewport.width}×${viewport.height} ${theme} 页面结构`)

  const errors = []
  const within = (actual, expected, tolerance = 2) => Math.abs(actual - expected) <= tolerance
  if (!within(value.innerWidth, viewport.width)) errors.push(`内容宽度 ${value.innerWidth} != ${viewport.width}`)
  if (!within(value.innerHeight, viewport.height)) errors.push(`内容高度 ${value.innerHeight} != ${viewport.height}`)
  if (!within(value.devicePixelRatio, 1, 0.01)) errors.push(`devicePixelRatio ${value.devicePixelRatio} != 1`)
  if (!value.page || !value.toolbar || !value.rail || !value.main) errors.push('Task Center 核心区域缺失')
  if (value.documentScrollWidth > value.innerWidth + 2) errors.push(`出现全局横向滚动：${value.documentScrollWidth} > ${value.innerWidth}`)
  if (value.documentScrollHeight > value.innerHeight + 2) errors.push(`出现全局纵向滚动：${value.documentScrollHeight} > ${value.innerHeight}`)
  if (value.rail && value.main && value.rail.right > value.main.left + 2) errors.push('任务列表与详情发生重叠')
  if (value.toolbar && value.toolbar.height > 54) errors.push(`Toolbar 过高：${value.toolbar.height}px`)
  if (value.rail && !within(value.rail.width, viewport.width >= 1200 ? 316 : viewport.width >= 992 ? 286 : 252)) errors.push(`任务 Rail 宽度偏离原型：${value.rail.width}px`)
  if (!['auto', 'scroll'].includes(value.overflow.railY)) errors.push(`左侧任务列表不是独立滚动根：overflow-y=${value.overflow.railY}`)
  if (value.overflow.main !== 'hidden') errors.push(`Task Center 主区应隔离全局滚动：overflow=${value.overflow.main}`)
  if (value.detailScroll && !['auto', 'scroll'].includes(value.overflow.detailY)) errors.push(`右侧详情不是独立滚动根：overflow-y=${value.overflow.detailY}`)

  const p = value.presentation
  if (p.toolGroupCount > 0 && p.closedToolGroupCount > 0) errors.push(`初始 Tool Group 有 ${p.closedToolGroupCount}/${p.toolGroupCount} 个被额外折叠`)
  if (p.toolFactCount > 0 && p.hiddenToolFactCount > 0) errors.push(`初始状态存在 ${p.hiddenToolFactCount}/${p.toolFactCount} 条 Tool Call 事实不可见`)
  if (p.toolGridColumnCount > 0 && viewport.width >= 1200 && p.toolGridColumnCount !== 4) errors.push(`Tool Row 桌面主基线不是四列：${p.toolGridColumns}`)
  if (p.toolFont > 0 && p.toolFont < 13) errors.push(`Tool Call 主体字号过小：${p.toolFont}px`)
  if (p.toolActionFont > 0 && p.toolActionFont < 13) errors.push(`Tool 操作名称字号过小：${p.toolActionFont}px`)
  if (p.toolTargetFont > 0 && p.toolTargetFont < 13) errors.push(`Tool 目标字号过小：${p.toolTargetFont}px`)
  if (p.toolStatusFont > 0 && p.toolStatusFont < 12) errors.push(`Tool 状态字号过小：${p.toolStatusFont}px`)
  if (p.userMessageFont > 0 && p.userMessageFont < 14) errors.push(`用户消息字号过小：${p.userMessageFont}px`)
  if (p.agentMessageFont > 0 && p.agentMessageFont < 14) errors.push(`Agent 消息字号过小：${p.agentMessageFont}px`)
  if (p.thinkingFont > 0 && p.thinkingFont < 13) errors.push(`Thinking 正文字号过小：${p.thinkingFont}px`)
  if (value.thinkingCount < 1) errors.push('Codex 可见 Thinking 未进入 Task Surface')
  if (p.toolRow && value.main && p.toolRow.right > value.main.right + 2) errors.push('Tool Row 超出详情主区')
  if (p.toolRowScrollWidth > p.toolRowClientWidth + 2) errors.push(`Tool Row 内部横向溢出：${p.toolRowScrollWidth} > ${p.toolRowClientWidth}`)
  if (p.liveOutputCount > 0 && !['auto', 'scroll'].includes(p.liveOutputOverflowY)) errors.push(`Pi Running 输出不是局部滚动：overflow-y=${p.liveOutputOverflowY}`)
  const liveMax = Number.parseFloat(p.liveOutputMaxHeight)
  if (p.liveOutputCount > 0 && Number.isFinite(liveMax) && liveMax > 200) errors.push(`Pi Running 输出局部高度过高：${p.liveOutputMaxHeight}`)
  if (p.errorOutputCount > 0 && p.closedErrorOutputCount > 0) errors.push(`错误 Tool 输出有 ${p.closedErrorOutputCount} 个未默认展开`)
  return { viewport, theme, value, errors, ok: errors.length === 0 }
}

async function runInspectorReturn(win) {
  const setup = await withTimeout(win.webContents.executeJavaScript(`(async () => {
    const pane = document.querySelector('.review-reader-pane')
    const trigger = document.querySelector('[data-tool-fact="true"] button.task-tool-row')
    if (!(pane instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return { skipped: true, reason: '缺少 Review Reader 或可点击 Tool Row' }
    trigger.dataset.acceptanceInspectorTrigger = 'true'
    trigger.scrollIntoView({ block: 'center' })
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const maxScroll = Math.max(0, pane.scrollHeight - pane.clientHeight)
    const beforeScrollTop = pane.scrollTop
    trigger.focus({ preventScroll: true })
    trigger.click()
    return { skipped: false, beforeScrollTop, maxScroll }
  })()`), 5_000, '打开 Tool Inspector')
  if (setup.skipped) return { ...setup, ok: false, errors: [setup.reason] }

  const opened = await withTimeout(win.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 40; i += 1) {
      const panel = document.querySelector('.inspector-panel[role="dialog"]')
      if (panel) {
        const firstTab = panel.querySelector('[role="tab"]')
        return { open: true, focusInside: panel.contains(document.activeElement), firstTabFocused: document.activeElement === firstTab }
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return { open: false, focusInside: false, firstTabFocused: false }
  })()`), 3_000, '等待 Tool Inspector')

  await withTimeout(win.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`), 2_000, 'Esc 关闭 Tool Inspector')
  await delay(120)
  const after = await withTimeout(win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.review-reader-pane')
    const trigger = document.querySelector('[data-acceptance-inspector-trigger="true"]')
    const value = { closed: !document.querySelector('.inspector-panel[role="dialog"]'), afterScrollTop: pane instanceof HTMLElement ? pane.scrollTop : -1, focusReturned: trigger instanceof HTMLElement && document.activeElement === trigger }
    if (trigger instanceof HTMLElement) delete trigger.dataset.acceptanceInspectorTrigger
    return value
  })()`), 3_000, '核对 Tool Inspector 返回状态')

  const errors = []
  if (!opened.open) errors.push('Tool Inspector 未打开')
  if (!opened.focusInside || !opened.firstTabFocused) errors.push('Tool Inspector 打开后焦点未进入首个 Tab')
  if (!after.closed) errors.push('Esc 未关闭 Tool Inspector')
  if (!after.focusReturned) errors.push('关闭 Tool Inspector 后焦点未返回原 Tool Call')
  if (Math.abs(after.afterScrollTop - setup.beforeScrollTop) > 2) errors.push(`关闭 Tool Inspector 后滚动位置漂移：${setup.beforeScrollTop} → ${after.afterScrollTop}`)
  if (setup.maxScroll > 0 && setup.beforeScrollTop <= 0) errors.push('Review Reader 可滚动但 Inspector 验收未建立非零阅读位置')
  return { skipped: false, ...setup, ...opened, ...after, errors, ok: errors.length === 0 }
}

async function clickTaskSequence(win, count) {
  return withTimeout(win.webContents.executeJavaScript(`(async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    for (let index = 0; index < ${count}; index += 1) {
      const buttons = [...document.querySelectorAll('.task-center-rail button.session-item')]
      if (buttons.length < 2) return { completed: index, available: buttons.length }
      buttons[index % 2].click()
      await delay(80)
    }
    return { completed: ${count}, available: document.querySelectorAll('.task-center-rail button.session-item').length }
  })()`), Math.max(5_000, count * 120), `${count} 次任务切换`)
}

async function collectDomCounters(win, label) {
  ensureDebugger(win)
  await withTimeout(win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage'), 3_000, `${label} 第一次 GC`)
  await delay(120)
  await withTimeout(win.webContents.debugger.sendCommand('HeapProfiler.collectGarbage'), 3_000, `${label} 第二次 GC`)
  await delay(120)
  return withTimeout(win.webContents.debugger.sendCommand('Memory.getDOMCounters'), 3_000, `${label} DOM Counters`)
}

async function runSwitchStability(win) {
  ensureDebugger(win)
  const initialCount = await withTimeout(win.webContents.executeJavaScript(`document.querySelectorAll('.task-center-rail button.session-item').length`), 3_000, '读取任务数量')
  if (initialCount < 2) return { skipped: true, reason: `真实任务不足 2 条（当前 ${initialCount} 条）`, requiredSwitches: 100, ok: true }
  await clickTaskSequence(win, 4)
  await delay(750)
  const before = await collectDomCounters(win, '切换前')
  const switched = await clickTaskSequence(win, 100)
  await delay(1500)
  const after = await collectDomCounters(win, '切换后')
  const listenerGrowth = after.jsEventListeners - before.jsEventListeners
  const nodeGrowth = after.nodes - before.nodes
  const maxNodeGrowth = Math.max(100, Math.ceil(before.nodes * 0.25))
  const errors = []
  if (switched.completed !== 100) errors.push(`仅完成 ${switched.completed}/100 次切换`)
  if (listenerGrowth > 20) errors.push(`GC 后 Listener 增长 ${listenerGrowth}，超过 +20`)
  if (nodeGrowth > maxNodeGrowth) errors.push(`GC 后 DOM Node 增长 ${nodeGrowth}，超过允许 ${maxNodeGrowth}`)
  return { skipped: false, requiredSwitches: 100, completedSwitches: switched.completed, before: { nodes: before.nodes, documents: before.documents, jsEventListeners: before.jsEventListeners }, after: { nodes: after.nodes, documents: after.documents, jsEventListeners: after.jsEventListeners }, growth: { nodes: nodeGrowth, jsEventListeners: listenerGrowth }, errors, ok: errors.length === 0 }
}

function createAcceptanceWindow() {
  return new BrowserWindow({ width: 1024, height: 700, show: false, backgroundColor: '#ffffff', webPreferences: { sandbox: true, contextIsolation: true } })
}

app.commandLine.appendSwitch('disable-gpu')
await app.whenReady()
await mkdir(outputDir, { recursive: true })
await persistReport()

const hardTimeout = setTimeout(async () => {
  report.ok = false
  report.error = report.error || '桌面验收超过 75 秒硬超时；报告已提前落盘以保留诊断信息'
  report.finishedAt = new Date().toISOString()
  try { await persistReport() } finally { app.exit(1) }
}, 75_000)

try {
  for (const viewport of viewports) {
    const win = createAcceptanceWindow()
    const diagnostic = { viewport, phase: 'created', consoleErrors: [], rendererGone: null }
    report.diagnostics.push(diagnostic)
    win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) diagnostic.consoleErrors.push(String(message).slice(0, 500)) })
    win.webContents.on('render-process-gone', (_event, details) => { diagnostic.rendererGone = { reason: details.reason, exitCode: details.exitCode } })
    try {
      diagnostic.phase = 'loading'
      await loadTaskCenter(win, `${viewport.width}×${viewport.height}`)
      diagnostic.phase = 'emulate-viewport'
      await applyViewport(win, viewport)
      diagnostic.phase = 'ready'
      await persistReport()
      for (const theme of themes) {
        diagnostic.phase = `inspect-${theme}`
        const result = await inspect(win, viewport, theme)
        diagnostic.phase = `capture-${theme}`
        const image = await captureViewport(win, viewport, theme)
        const prefix = `task-center-${viewport.width}x${viewport.height}-${theme}`
        await writeFile(resolve(outputDir, `${prefix}.png`), image)
        await writeFile(resolve(outputDir, `${prefix}.json`), `${JSON.stringify(result, null, 2)}\n`)
        report.cases.push(result)
        if (!result.ok) report.ok = false
        await persistReport()
        console.log(`${result.ok ? '✓' : '✗'} ${viewport.width}×${viewport.height} ${theme} · rail=${Math.round(result.value.rail?.width || 0)}px · rounds=${result.value.roundCount} · tools=${result.value.toolCount}`)
        for (const error of result.errors) console.error(`  - ${error}`)
      }
      if (viewport.width === 1280) {
        diagnostic.phase = 'inspector-return'
        report.inspectorReturn = await withTimeout(runInspectorReturn(win), 10_000, 'Inspector 返回位置与焦点验收')
        if (!report.inspectorReturn.ok) report.ok = false
        await persistReport()
        for (const error of report.inspectorReturn.errors ?? []) console.error(`  - ${error}`)
      }
      diagnostic.phase = 'done'
    } finally {
      safeDetachDebugger(win)
      if (!win.isDestroyed()) win.destroy()
      await delay(120)
    }
  }

  const switchWin = createAcceptanceWindow()
  try {
    await loadTaskCenter(switchWin, '100 次任务切换')
    await applyViewport(switchWin, viewports[0])
    report.switchStability = await withTimeout(runSwitchStability(switchWin), 25_000, '100 次任务切换稳定性')
    if (!report.switchStability.ok) report.ok = false
    await persistReport()
    if (report.switchStability.skipped) console.log(`• 100 次任务切换验收 skipped：${report.switchStability.reason}`)
    else console.log(`${report.switchStability.ok ? '✓' : '✗'} 100 次任务切换（GC 后）· listeners ${report.switchStability.growth.jsEventListeners >= 0 ? '+' : ''}${report.switchStability.growth.jsEventListeners} · nodes ${report.switchStability.growth.nodes >= 0 ? '+' : ''}${report.switchStability.growth.nodes}`)
  } finally {
    safeDetachDebugger(switchWin)
    if (!switchWin.isDestroyed()) switchWin.destroy()
  }
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  console.error(report.error)
} finally {
  clearTimeout(hardTimeout)
  report.finishedAt = new Date().toISOString()
  await persistReport()
  app.exit(report.ok ? 0 : 1)
}
