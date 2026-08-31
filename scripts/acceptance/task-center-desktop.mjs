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
const report = { kind: 'task-center-desktop', baseUrl, path, startedAt: new Date().toISOString(), cases: [], switchStability: null, ok: true }

function fail(message) {
  throw new Error(message)
}

async function waitForTaskCenter(win) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.task-center-page'))`).catch(() => false)
    if (ready) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  fail('30 秒内没有出现 .task-center-page；请确认 AgentLens 已运行且验收 URL 指向任务中心')
}

async function inspect(win, viewport, theme) {
  await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 80))

  const value = await win.webContents.executeJavaScript(`(() => {
    const pick = selector => document.querySelector(selector)
    const rect = element => element ? (() => { const r = element.getBoundingClientRect(); return { left:r.left, top:r.top, right:r.right, bottom:r.bottom, width:r.width, height:r.height } })() : null
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
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      documentScrollWidth: root?.scrollWidth || 0,
      documentScrollHeight: root?.scrollHeight || 0,
      page: rect(page), toolbar: rect(toolbar), rail: rect(rail), railScroll: rect(railScroll), main: rect(main), detailScroll: rect(detailScroll),
      overflow: {
        page: pageStyle?.overflow || '', rail: railStyle?.overflow || '', railY: railScrollStyle?.overflowY || '', main: mainStyle?.overflow || '', detailY: detailStyle?.overflowY || '',
      },
      messageCount: document.querySelectorAll('.task-message-row').length,
      roundCount: document.querySelectorAll('[data-task-round-state]').length,
      thinkingCount: document.querySelectorAll('.thinking-block').length,
      toolCount: document.querySelectorAll('.execution-row').length,
      taskButtonCount: document.querySelectorAll('.task-center-rail button.session-item').length,
      theme: document.documentElement.dataset.theme || 'light',
    }
  })()`)

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

  return { viewport, theme, value, errors, ok: errors.length === 0 }
}

async function clickTaskSequence(win, count) {
  return win.webContents.executeJavaScript(`(async () => {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
    for (let index = 0; index < ${count}; index += 1) {
      const buttons = [...document.querySelectorAll('.task-center-rail button.session-item')]
      if (buttons.length < 2) return { completed: index, available: buttons.length }
      const target = buttons[index % 2]
      target.click()
      await delay(80)
    }
    return { completed: ${count}, available: document.querySelectorAll('.task-center-rail button.session-item').length }
  })()`)
}

async function runSwitchStability(win) {
  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3')
  const initialCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.task-center-rail button.session-item').length`)
  if (initialCount < 2) {
    return { skipped: true, reason: `真实任务不足 2 条（当前 ${initialCount} 条）`, requiredSwitches: 100, ok: true }
  }

  await clickTaskSequence(win, 4)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  const before = await win.webContents.debugger.sendCommand('Memory.getDOMCounters')
  const switched = await clickTaskSequence(win, 100)
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1000))
  const after = await win.webContents.debugger.sendCommand('Memory.getDOMCounters')
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

await app.whenReady()
await mkdir(outputDir, { recursive: true })

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
    try {
      await win.loadURL(`${baseUrl}${path}`)
      await waitForTaskCenter(win)
      for (const theme of themes) {
        const result = await inspect(win, viewport, theme)
        const image = await win.webContents.capturePage()
        const prefix = `task-center-${viewport.width}x${viewport.height}-${theme}`
        await writeFile(resolve(outputDir, `${prefix}.png`), image.toPNG())
        await writeFile(resolve(outputDir, `${prefix}.json`), `${JSON.stringify(result, null, 2)}\n`)
        report.cases.push(result)
        if (!result.ok) report.ok = false
        console.log(`${result.ok ? '✓' : '✗'} ${viewport.width}×${viewport.height} ${theme} · rail=${Math.round(result.value.rail?.width || 0)}px · rounds=${result.value.roundCount} · tools=${result.value.toolCount}`)
        for (const error of result.errors) console.error(`  - ${error}`)
      }
      if (viewport.width === 1280) {
        report.switchStability = await runSwitchStability(win)
        if (!report.switchStability.ok) report.ok = false
        if (report.switchStability.skipped) console.log(`• 100 次任务切换验收 skipped：${report.switchStability.reason}`)
        else console.log(`${report.switchStability.ok ? '✓' : '✗'} 100 次任务切换 · listeners ${report.switchStability.growth.jsEventListeners >= 0 ? '+' : ''}${report.switchStability.growth.jsEventListeners} · nodes ${report.switchStability.growth.nodes >= 0 ? '+' : ''}${report.switchStability.growth.nodes}`)
      }
    } finally {
      if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
      win.destroy()
    }
  }
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  console.error(report.error)
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(outputDir, 'task-center-desktop-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  app.exit(report.ok ? 0 : 1)
}
