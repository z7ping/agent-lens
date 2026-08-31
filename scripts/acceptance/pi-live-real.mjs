import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const baseUrl = (process.env.AGENT_LENS_ACCEPTANCE_URL || 'http://127.0.0.1:56789').replace(/\/$/, '')
const cwd = resolve(process.env.AGENT_LENS_ACCEPTANCE_CWD || process.cwd())
const timeoutMs = Number(process.env.AGENT_LENS_ACCEPTANCE_TIMEOUT_MS || 180_000)
const keepRuntime = process.env.AGENT_LENS_ACCEPTANCE_KEEP_RUNTIME === '1'
const marker = `agentlens-alpha3-${Date.now()}`
const outputDir = resolve(process.env.AGENT_LENS_ACCEPTANCE_OUTPUT || '.agent-lens/acceptance')
const startedAt = new Date().toISOString()
const report = {
  kind: 'pi-live-real',
  marker,
  baseUrl,
  cwd,
  startedAt,
  runtimeSessionId: null,
  checks: [],
  events: {},
  controls: {},
  history: null,
}

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail, at: new Date().toISOString() })
  const prefix = ok ? '✓' : '✗'
  console.log(`${prefix} ${name}${detail ? ` · ${detail}` : ''}`)
  if (!ok) throw new Error(`${name}${detail ? `：${detail}` : ''}`)
}

async function json(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { accept: 'application/json', ...(init.headers || {}) },
    signal: init.signal || AbortSignal.timeout(timeoutMs),
  })
  let body
  try { body = await response.json() } catch { body = null }
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}${body?.message ? `：${body.message}` : ''}`)
  return body
}

function post(path, body) {
  return json(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function eventType(value) {
  return value?.event && typeof value.event.type === 'string' ? value.event.type : ''
}

function createEventCollector(runtimeSessionId) {
  const controller = new AbortController()
  const events = []
  const waiters = new Set()
  let task

  const notify = value => {
    events.push(value)
    const type = eventType(value)
    report.events[type] = (report.events[type] || 0) + 1
    for (const waiter of [...waiters]) {
      if (waiter.predicate(value, events)) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(value)
      }
    }
  }

  const waitFor = (label, predicate, ms = timeoutMs) => new Promise((resolveWait, rejectWait) => {
    for (const value of events) {
      if (predicate(value, events)) return resolveWait(value)
    }
    const waiter = {
      predicate,
      resolve: resolveWait,
      timer: setTimeout(() => {
        waiters.delete(waiter)
        rejectWait(new Error(`等待 ${label} 超时（${ms}ms）`))
      }, ms),
    }
    waiters.add(waiter)
  })

  const start = async () => {
    const response = await fetch(`${baseUrl}/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw new Error(`SSE 连接失败：HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!controller.signal.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let boundary
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const eventName = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim()
        if (eventName && eventName !== 'pi-live') continue
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        try {
          const parsed = JSON.parse(data)
          if (parsed.runtimeSessionId === runtimeSessionId) notify(parsed)
        } catch { /* ignore transport keepalive / malformed frame */ }
      }
    }
  }

  return {
    events,
    waitFor,
    connect() {
      task = start().catch(error => {
        if (!controller.signal.aborted) throw error
      })
      return task
    },
    async close() {
      controller.abort()
      await task?.catch(() => undefined)
    },
  }
}

async function waitForState(runtimeSessionId, predicate, label, ms = timeoutMs) {
  const deadline = Date.now() + ms
  let last
  while (Date.now() < deadline) {
    last = await json(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/state`)
    if (predicate(last)) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 300))
  }
  throw new Error(`等待 ${label} 超时；最后状态=${JSON.stringify(last)}`)
}

async function verifyHistory(markerText, sinceIso) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const value = await json('/api/v1/review?limit=500')
    const items = Array.isArray(value?.items) ? value.items : []
    const hit = items.find(item => {
      const timeOk = !item.startedAt || Date.parse(item.startedAt) >= Date.parse(sinceIso) - 60_000
      const sourceOk = Array.isArray(item.sourceIds) && item.sourceIds.some(value => String(value).toLowerCase().includes('pi'))
      const text = `${item.title || ''}\n${item.preview || ''}`
      return timeOk && sourceOk && (text.includes(markerText) || item.workspacePath === cwd)
    })
    if (hit) return hit
    await new Promise(resolveDelay => setTimeout(resolveDelay, 1000))
  }
  return null
}

let runtimeSessionId
let collector
try {
  const health = await json('/api/v1/health')
  check('AgentLens Runtime 可用', Boolean(health), `protocol=${health?.protocolVersion || 'unknown'}`)

  const availability = await json('/api/v1/pi-live/availability')
  check('真实 Pi 可发现', availability?.available === true, availability?.executable || availability?.reason || '')

  const state = await post('/api/v1/pi-live', {
    cwd,
    name: `${marker} 真实验收`,
  })
  runtimeSessionId = state.runtimeSessionId
  report.runtimeSessionId = runtimeSessionId
  check('创建真实 Pi Runtime', Boolean(runtimeSessionId), runtimeSessionId)

  collector = createEventCollector(runtimeSessionId)
  await collector.connect()
  await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  check('SSE 实时通道已连接', true)

  const controls = await json(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/controls`)
  report.controls = {
    modelCount: Array.isArray(controls?.models) ? controls.models.length : 0,
    thinkingLevels: Array.isArray(controls?.thinkingLevels) ? controls.thinkingLevels : [],
  }
  check('真实 Pi Controls 可读取', report.controls.modelCount > 0, `${report.controls.modelCount} models`)

  if (controls?.models?.length) {
    const current = state.model && typeof state.model === 'object' ? state.model : {}
    const same = controls.models.find(item => item.provider === current.provider && item.id === current.id) || controls.models[0]
    const changed = await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/model`, { provider: same.provider, modelId: same.id })
    check('真实 Pi Model 设置链路', Boolean(changed?.model), `${same.provider}/${same.id}`)
  }

  if (controls?.thinkingLevels?.length) {
    const level = controls.thinkingLevels.includes(state.thinkingLevel) ? state.thinkingLevel : controls.thinkingLevels[0]
    const changed = await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/thinking-level`, { level })
    check('真实 Pi Thinking Level 设置链路', changed?.thinkingLevel === level, String(level))
  }

  await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/prompt`, {
    message: `这是 AgentLens alpha.3 真实链路验收，标记 ${marker}。请务必使用一个只读工具读取当前工作目录中的 package.json；如果不存在就列出当前目录。工具执行后，用一句话回复，并原样包含 ${marker}。`,
  })
  await collector.waitFor('Streaming', value => ['message_start', 'message_update'].includes(eventType(value)))
  check('Prompt → Streaming', true)

  await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/steer`, { message: `补充要求：最终回复再包含 ${marker}-steer。` })
  check('Steer 已被真实 Runtime 接收', true)
  await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/follow-up`, { message: `当前轮结束后，请再回复一句 ${marker}-followup。` })
  check('Follow-up 已被真实 Runtime 接收', true)

  await collector.waitFor('Tool', value => ['tool_execution_start', 'tool_execution_end', 'bash_execution_start', 'bash_execution_update', 'bash_execution_end'].includes(eventType(value)))
  check('Streaming → Tool', true)
  await collector.waitFor('第一轮 settled', value => ['agent_settled', 'agent_end'].includes(eventType(value)))
  check('首轮完成并 settled', true)

  await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/prompt`, {
    message: `继续做一次可中止验收 ${marker}-abort：请读取 README.md 和 package.json，并比较两者的项目描述后再回答。`,
  })
  await waitForState(runtimeSessionId, current => current.isStreaming === true, 'Abort 前进入 Streaming', 30_000)
  const restored = await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/abort`, { restoreQueue: true })
  check('Abort + Queue Restore', Array.isArray(restored?.steering) && Array.isArray(restored?.followUp), `steering=${restored?.steering?.length || 0}, followUp=${restored?.followUp?.length || 0}`)
  await waitForState(runtimeSessionId, current => current.isStreaming === false, 'Abort 后停止 Streaming', 30_000)

  const beforeReconnect = await json(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/snapshot`)
  const leafId = beforeReconnect?.leafId || undefined
  await collector.close()
  collector = createEventCollector(runtimeSessionId)
  await collector.connect()
  const recovered = await json(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/snapshot${leafId ? `?since=${encodeURIComponent(leafId)}` : ''}`)
  check('Reconnect + Snapshot 恢复', recovered?.state?.runtimeSessionId === runtimeSessionId, `leaf=${recovered?.leafId || 'none'}`)

  await post(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}/prompt`, { message: `只回复 ${marker}-reconnect。` })
  await collector.waitFor('Reconnect 后 settled', value => ['agent_settled', 'agent_end'].includes(eventType(value)))
  check('Reconnect 后继续对话', true)

  report.history = await verifyHistory(marker, startedAt)
  check('source-pi / Review 可看到同一真实会话历史', Boolean(report.history), report.history?.id || '')

  if (!keepRuntime) {
    await json(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}`, { method: 'DELETE' })
    const runtimes = await json('/api/v1/pi-live')
    check('Terminate Runtime 后从活跃列表移除', !runtimes.some(item => item.runtimeSessionId === runtimeSessionId))
  } else {
    console.log(`• 保留 Runtime：${runtimeSessionId}`)
  }

  report.finishedAt = new Date().toISOString()
  report.ok = true
} catch (error) {
  report.finishedAt = new Date().toISOString()
  report.ok = false
  report.error = error instanceof Error ? error.stack || error.message : String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  await collector?.close().catch(() => undefined)
  if (runtimeSessionId && !keepRuntime && !report.ok) {
    await json(`/api/v1/pi-live/${encodeURIComponent(runtimeSessionId)}`, { method: 'DELETE', signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
  }
  await mkdir(outputDir, { recursive: true })
  const path = resolve(outputDir, `pi-live-real-${marker}.json`)
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`真实 Pi 验收报告：${path}`)
}
