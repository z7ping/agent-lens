import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { app, BrowserWindow } from 'electron'

function arg(name, fallback) {
  const prefix = `--${name}=`
  const found = process.argv.find(value => value.startsWith(prefix))
  return found ? found.slice(prefix.length) : fallback
}

const baseUrl = (arg('url', process.env.AGENT_LENS_ACCEPTANCE_URL || 'http://127.0.0.1:56789')).replace(/\/$/, '')
const runtimeId = arg('runtime', process.env.AGENT_LENS_ACCEPTANCE_RUNTIME_ID || '')
const route = arg('path', runtimeId ? `/review/live/${encodeURIComponent(runtimeId)}` : '/review')
const durationMs = Number(arg('duration', process.env.AGENT_LENS_ACCEPTANCE_DURATION_MS || 60 * 60_000))
const sampleMs = Number(arg('sample', process.env.AGENT_LENS_ACCEPTANCE_SAMPLE_MS || 60_000))
const outputDir = resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance/resource-soak')
const startedAt = Date.now()
const samples = []

if (!Number.isFinite(durationMs) || durationMs < 10_000) throw new Error('duration 必须 >= 10000ms')
if (!Number.isFinite(sampleMs) || sampleMs < 1_000) throw new Error('sample 必须 >= 1000ms')

function metricMap(metrics) {
  return Object.fromEntries((metrics || []).map(item => [item.name, item.value]))
}

function growth(first, last) {
  if (!Number.isFinite(first) || !Number.isFinite(last)) return null
  return { absolute: last - first, ratio: first ? (last - first) / first : null }
}

function summarize(key) {
  const values = samples.map(item => item[key]).filter(Number.isFinite)
  if (!values.length) return null
  return {
    first: values[0],
    last: values.at(-1),
    min: Math.min(...values),
    max: Math.max(...values),
    growth: growth(values[0], values.at(-1)),
  }
}

await app.whenReady()
await mkdir(outputDir, { recursive: true })

const win = new BrowserWindow({
  width: 1280,
  height: 800,
  useContentSize: true,
  show: process.env.AGENT_LENS_ACCEPTANCE_SHOW === '1',
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    backgroundThrottling: false,
  },
})

let errorText = ''
try {
  await win.loadURL(`${baseUrl}${route}`)
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.task-center-page'))`).catch(() => false)
    if (ready) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200))
  }
  const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.task-center-page'))`)
  if (!ready) throw new Error('没有进入 Task Center；请确认 URL、Runtime 和当前数据')

  win.webContents.debugger.attach('1.3')
  await win.webContents.debugger.sendCommand('Performance.enable')

  const endAt = startedAt + durationMs
  let index = 0
  while (Date.now() <= endAt) {
    const performanceMetrics = metricMap((await win.webContents.debugger.sendCommand('Performance.getMetrics')).metrics)
    const dom = await win.webContents.debugger.sendCommand('Memory.getDOMCounters')
    const processMemory = await win.webContents.getProcessMemoryInfo()
    const rendererPid = win.webContents.getOSProcessId()
    const appMetric = app.getAppMetrics().find(item => item.pid === rendererPid)
    const ui = await win.webContents.executeJavaScript(`(() => ({
      path: location.pathname,
      hidden: document.hidden,
      rounds: document.querySelectorAll('[data-task-round-state]').length,
      messages: document.querySelectorAll('.task-message-row').length,
      tools: document.querySelectorAll('.execution-row').length,
      globalScrollHeight: document.scrollingElement?.scrollHeight || 0,
      innerHeight: innerHeight,
    }))()`)
    const sample = {
      index,
      at: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      jsHeapUsedBytes: performanceMetrics.JSHeapUsedSize ?? null,
      jsHeapTotalBytes: performanceMetrics.JSHeapTotalSize ?? null,
      nodes: dom.nodes,
      documents: dom.documents,
      jsEventListeners: dom.jsEventListeners,
      rssKb: processMemory.residentSet ?? processMemory.workingSetSize ?? null,
      privateKb: processMemory.private ?? null,
      cpuPercent: appMetric?.cpu?.percentCPUUsage ?? null,
      ...ui,
    }
    samples.push(sample)
    console.log(`${sample.at} heap=${Math.round((sample.jsHeapUsedBytes || 0) / 1024 / 1024)}MB rss=${Math.round((sample.rssKb || 0) / 1024)}MB dom=${sample.nodes} listeners=${sample.jsEventListeners} cpu=${Number(sample.cpuPercent || 0).toFixed(2)}% rounds=${sample.rounds}`)
    index += 1
    if (Date.now() >= endAt) break
    await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(sampleMs, Math.max(0, endAt - Date.now()))))
  }
} catch (error) {
  errorText = error instanceof Error ? error.stack || error.message : String(error)
  console.error(errorText)
  process.exitCode = 1
} finally {
  if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
  const report = {
    kind: 'task-center-resource-soak',
    baseUrl,
    route,
    durationMs,
    sampleMs,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    ok: !errorText,
    error: errorText || undefined,
    sampleCount: samples.length,
    summary: {
      jsHeapUsedBytes: summarize('jsHeapUsedBytes'),
      rssKb: summarize('rssKb'),
      nodes: summarize('nodes'),
      jsEventListeners: summarize('jsEventListeners'),
      cpuPercent: summarize('cpuPercent'),
    },
    samples,
  }
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, '-')
  const path = resolve(outputDir, `task-center-resource-soak-${stamp}.json`)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`资源趋势报告：${path}`)
  win.destroy()
  app.quit()
}
