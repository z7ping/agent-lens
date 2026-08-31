import { mkdir, writeFile } from 'node:fs/promises'
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
const report = { kind: 'task-center-desktop', baseUrl, path, startedAt: new Date().toISOString(), cases: [], switchStability: null, diagnostics: [], ok: true }

function fail(message) {
  throw new Error(message)
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超过 ${Math.round(timeoutMs / 1000)} 秒`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function persistReport() {
  await writeFile(resolve(outputDir, 'task-center-desktop-report.json'), `${JSON.stringify(report, null, 2)}\n`)
}

async function waitForTaskCenter(win) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const ready = await withTimeout(
      win.webContents.executeJavaScript(`Boolean(document.querySelector('.task-center-page'))`),
      2_000,
      '查询 .task-center-page',
    ).catch(() => false)
    if (ready) return
    await delay(200)
  }
  fail('20 秒内没有出现 .task-center-page；请确认 AgentLens 已运行且验收 URL 指向任务中心')
}

async function inspect(win, viewport, theme) {
  await withTimeout(
    win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`),
    3_000,
    `切换 ${theme} 主题`,
  )
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
    const detailScroll = pick('.review-reader-pane') || pick('.pi-live-document') || pick('.pi-live-page') || pick('.task-center-new')
    const pageStyle = page ? getComputedStyle(page) : null
    const railStyle = rail ? getComputedStyle(rail) : null
    const railScrollStyle = railScroll ? getComputedStyle(railScroll) : null
    const mainStyle = main ? getComputedStyle(main) : null
    const detailStyle = detailScroll ? getComputedStyle(detailScroll) : null
    const root = document.scrollingElement
    const toolGroups = all('[data-task-tool-group="true"]')
    const toolFacts = all('[data-tool-fact="true"]')
    const toolRows = all('[data-tool-fact="true"] .tool-row')
    const firstTool = toolRows[0] || null
    const firstToolAction = firstTool?.querySelector('.tool-action') || null
    const firstToolTarget = firstTool?.querySelector('.tool-target') || null
    const firstToolStatus = firstTool?.querySelector('.tool-status') || null
    const firstUserBubble = pick('[data-task-message-role="user"] .task-message-bubble')
    const firstAgentBubble = pick('[data-task-message-role="assistant"] .task-message-bubble')
    const firstThinkingContent = pick('.thinking-content')
    const liveOutputs = all('.tool-live-output')
    const errorOutputDetails = all('.task-tool-row-shell:has(.tool-row[data-status="error"]) .tool-output-details')
    const toolStyle = firstTool ? getComputedStyle(firstTool) : null
    const liveStyle = liveOutputs[0] ? getComputedStyle(liveOutputs[0]) : null
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentScrollWidth: root?.scrollWidth || 0,
      documentScrollHeight: root?.scrollHeight || 0,
      page: rect(page), toolbar: rect(toolbar), rail: rect(rail), railScroll: rect(railScroll), main: rect(main), detailScroll: rect(detailScroll),
      overflow: {
        page: pageStyle?.overflow || '', rail: railStyle?.overflow || '', railY: railScrollStyle?.overflowY || '', main: mainStyle?.overflow || '', detailY: detailStyle?.overflowY || '',
      },
      messageCount: all('.task-message-row').length,
      roundCount: all('[data-task-round-state]').length,
      thinkingCount: all('.thinking-block').length,
      toolCount: toolRows.length,
      taskButtonCount: all('.task-center-rail button.session-item').length,
      presentation: {
        toolGroupCount: toolGroups.length,
        collapsibleToolGroupCount: toolGroups.filter(group => group.tagName === 'DETAILS').length,
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
  if (!value.page || !value.toolbar || !value.rail || !value.main) errors.push('Task Center 核心区域缺失')
  if (value.documentScrollWidth > value.innerWidth + 2) errors.push(`出现全局横向滚动：${value.documentScrollWidth} > ${value.innerWidth}`)
  if (value.documentScrollHeight > value.innerHeight + 2) errors.push(`出现全局纵向滚动：${value.documentScrollHeight} > ${value.innerHeight}`)
  if (value.rail && value.main && value.rail.right > value.main.left + 2) errors.push('任务列表与详情发生重叠')
  if (value.toolbar && value.toolbar.height > 54) errors.push(`Toolbar 过高：${value.toolbar.height}px`)
  if (value.rail && (value.rail.width < 250 || value.rail.width > 330)) errors.push(`任务 Rail 宽度异常：${value.rail.width}px`)
  if (!['auto', 'scroll'].includes(value.overflow.railY)) errors.push(`左侧任务列表不是独立滚动根：overflow-y=${value.overflow.railY}`)
  if (value.overflow.main !== 'hidden') errors.push(`Task Center 主区应隔离全局滚动：overflow=${value.overflow.main}`)
  if (value.detailScroll && !['auto', 'scroll'].includes(value.overflow.detailY)) errors.push(`右侧详情不是独立滚动根：overflow-y=${value.overflow.detailY}`)

  const p = value.presentation
  if (p.collapsibleToolGroupCount > 0) errors.push(`Tool Group 仍有 ${p.collapsibleToolGroupCount} 个使用组级折叠，会隐藏 Tool Call 事实`)
  if (p.hiddenToolFactCount > 0) errors.push(`存在 ${p.hiddenToolFactCount}/${p.toolFactCount} 条 Tool Call 事实不可见`)
  if (p.toolGridColumnCount > 0 && viewport.width >= 1200 && p.toolGridColumnCount !== 4) errors.push(`Tool Row 桌面主基线不是四列：${p.toolGridColumns}`)
  if (p.toolFont > 0 && p.toolFont < 13) errors.push(`Tool Call 主体字号过小：${p.toolFont}px`)
  if (p.toolActionFont > 0 && p.toolActionFont < 13) errors.push(`Tool 操作名称字号过小：${p.toolActionFont}px`)
  if (p.toolTargetFont > 0 && p.toolTargetFont < 13) errors.push(`Tool 目标字号过小：${p.toolTargetFont}px`)
  if (p.toolStatusFont > 0 && p.toolStatusFont < 12) errors.push(`Tool 状态字号过小：${p.toolStatusFont}px`)
  if (p.userMessageFont > 0 && p.userMessageFont < 14) errors.push(`用户消息字号过小：${p.userMessageFont}px`)
  if (p.agentMessageFont > 0 && p.agentMessageFont < 14) errors.push(`Agent 消息字号过小：${p.agentMessageFont}px`)
  if (p.thinkingFont > 0 && p.thinkingFont < 13) errors.push(`Thinking 正文字号过小：${p.thinkingFont}px`)
  if (p.toolRow && value.main && p.toolRow.right > value.main.right + 2) errors.push('Tool Row 超出详情主区')
  if (p.toolRowScrollWidth > p.toolRowClientWidth + 2) errors.push(`Tool Row 内部横向溢出：${p.toolRowScrollWidth} > ${p.toolRowClientWidth}`)
  if (p.liveOutputCount > 0 && !['auto', 'scroll'].includes(p.liveOutputOverflowY)) errors.push(`Pi Running 输出不是局部滚动：overflow-y=${p.liveOutputOverflowY}`)
  if (p.errorOutputCount > 0 && p.closedErrorOutputCount > 0) errors.push(`错误 Tool 输出有 ${p.closedErrorOutputCount} 个未默认展开`)

  return { viewport, theme, value, errors, ok: errors.length === 0 }
}

async function clickTaskSequence(win, count) {
  return withTimeout(win.webContents.executeJavaScript(`(async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    for (let index = 0; index < ${count}; index += 1) {
      const buttons = [...document.querySelectorAll('.task-center-rail button.session-item')]
      if (buttons.length < 2) return { completed: index, available: buttons.length }
      const target = buttons[index % 2]
      target.click()
      await delay(80)
    }
    return { completed: ${count}, available: document.querySelectorAll('.task-center-rail button.session-item').length }
  })()`), Math.max(5_000, count * 120), `${count} 次任务切换`)
}

async function runSwitchStability(win) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  const initialCount = await withTimeout(
    win.webContents.executeJavaScript(`document.querySelectorAll('.task-center-rail button.session-item').length`),
    3_000,
    '读取任务数量',
  )
  if (initialCount < 2) {
    return { skipped: true, reason: `真实任务不足 2 条（当前 ${initialCount} 条）`, requiredSwitches: 100, ok: true }
  }

  await clickTaskSequence(win, 4)
  await delay(500)
  const before = await withTimeout(win.webContents.debugger.sendCommand('Memory.getDOMCounters'), 3_000, '读取切换前 DOM Counters')
  const switched = await clickTaskSequence(win, 100)
  await delay(1000)
  const after = await withTimeout(win.webContents.debugger.sendCommand('Memory.getDOMCounters'), 3_000, '读取切换后 DOM Counters')
  const listenerGrowth = after.jsEventListeners - before.jsEventListeners
  const nodeGrowth = after.nodes - before.nodes
  const maxNodeGrowth = Math.max(100, Math.ceil(before.nodes * 0.25))
  const errors = []
  if (switched.completed !== 100) errors.push(`仅完成 ${switched.completed}/100 次切换`)
  if (listenerGrowth > 20) errors.push(`Listener 增长 ${listenerGrowth}，超过 +20`)
  if (nodeGrowth > maxNodeGrowth) errors.push(`DOM Node 增长 ${nodeGrowth}，超过允许 ${maxNodeGrowth}`)
  return {
    skipped: false,
    requiredSwitches: 100,
    completedSwitches: switched.completed,
    before: { nodes: before.nodes, documents: before.documents, jsEventListeners: before.jsEventListeners },
    after: { nodes: after.nodes, documents: after.documents, jsEventListeners: after.jsEventListeners },
    growth: { nodes: nodeGrowth, jsEventListeners: listenerGrowth },
    errors,
    ok: errors.length === 0,
  }
}

app.commandLine.appendSwitch('disable-gpu')
await app.whenReady()
await mkdir(outputDir, { recursive: true })
await persistReport()

let hardTimeout
hardTimeout = setTimeout(async () => {
  report.ok = false
  report.error = report.error || '桌面验收超过 70 秒硬超时；报告已提前落盘以保留诊断信息'
  report.finishedAt = new Date().toISOString()
  try {
    await persistReport()
  } finally {
    app.exit(1)
  }
}, 70_000)

try {
  for (const viewport of viewports) {
    const win = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      show: false,
      backgroundColor: '#ffffff',
      webPreferences: { sandbox: true, contextIsolation: true },
    })
    const diagnostic = { viewport, phase: 'created', consoleErrors: [], rendererGone: null }
    report.diagnostics.push(diagnostic)
    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) diagnostic.consoleErrors.push(String(message).slice(0, 500))
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      diagnostic.rendererGone = { reason: details.reason, exitCode: details.exitCode }
    })
    try {
      diagnostic.phase = 'loading'
      await withTimeout(win.loadURL(`${baseUrl}${path}`), 15_000, `${viewport.width}×${viewport.height} 页面加载`)
      diagnostic.phase = 'waiting-task-center'
      await waitForTaskCenter(win)
      diagnostic.phase = 'ready'
      await persistReport()

      for (const theme of themes) {
        diagnostic.phase = `inspect-${theme}`
        const result = await inspect(win, viewport, theme)
        diagnostic.phase = `capture-${theme}`
        const image = await withTimeout(win.webContents.capturePage(), 8_000, `${viewport.width}×${viewport.height} ${theme} 截图`)
        const prefix = `task-center-${viewport.width}x${viewport.height}-${theme}`
        await writeFile(resolve(outputDir, `${prefix}.png`), image.toPNG())
        await writeFile(resolve(outputDir, `${prefix}.json`), `${JSON.stringify(result, null, 2)}\n`)
        report.cases.push(result)
        if (!result.ok) report.ok = false
        diagnostic.phase = `captured-${theme}`
        await persistReport()
        console.log(`${result.ok ? '✓' : '✗'} ${viewport.width}×${viewport.height} ${theme} · rail=${Math.round(result.value.rail?.width || 0)}px · rounds=${result.value.roundCount} · tools=${result.value.toolCount}`)
        for (const error of result.errors) console.error(`  - ${error}`)
      }
      if (viewport.width === 1280) {
        diagnostic.phase = 'switch-stability'
        report.switchStability = await withTimeout(runSwitchStability(win), 20_000, '100 次任务切换稳定性')
        if (!report.switchStability.ok) report.ok = false
        await persistReport()
        if (report.switchStability.skipped) console.log(`• 100 次任务切换验收 skipped：${report.switchStability.reason}`)
        else console.log(`${report.switchStability.ok ? '✓' : '✗'} 100 次任务切换 · listeners ${report.switchStability.growth.jsEventListeners >= 0 ? '+' : ''}${report.switchStability.growth.jsEventListeners} · nodes ${report.switchStability.growth.nodes >= 0 ? '+' : ''}${report.switchStability.growth.nodes}`)
      }
      diagnostic.phase = 'done'
      await persistReport()
    } finally {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      if (!win.isDestroyed()) win.destroy()
    }
  }
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  console.error(report.error)
} finally {
  if (hardTimeout) clearTimeout(hardTimeout)
  report.finishedAt = new Date().toISOString()
  await persistReport()
  app.exit(report.ok ? 0 : 1)
}
