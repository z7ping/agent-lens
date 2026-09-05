import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn, type ChildProcess } from 'node:child_process'
import { projectionReadinessInternals } from '../../apps/daemon/src/projection-readiness'
import { SqliteStorageService } from '../../packages/storage-sqlite/src/index'

type StartupMode = 'unclean' | 'clean' | 'cycle'

function readPositiveInt(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

function readStartupMode(): StartupMode {
  const prefix = '--startup-mode='
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return 'cycle'
  if (raw === 'unclean' || raw === 'clean' || raw === 'cycle') return raw
  throw new Error(`startup-mode must be one of unclean, clean, cycle; received ${raw}`)
}

const sessions = readPositiveInt('sessions', 100)
const observationsPerSession = readPositiveInt('observations-per-session', 20)
const timeoutMs = readPositiveInt('timeout-ms', 30_000)
const startupMode = readStartupMode()
const root = mkdtempSync(join(tmpdir(), 'agent-lens-daemon-startup-'))
const databasePath = join(root, 'agent-lens.db')
const vaultPath = join(root, 'vault')
const webRoot = join(root, 'web')
mkdirSync(vaultPath, { recursive: true })
mkdirSync(webRoot, { recursive: true })
const port = 40_000 + Math.floor(Math.random() * 20_000)
const storage = new SqliteStorageService({ path: databasePath })

function isoAt(offsetSeconds: number): string {
  return new Date(Date.UTC(2026, 7, 1) + offsetSeconds * 1000).toISOString()
}

async function seed(): Promise<number> {
  await storage.migrate()
  const { db } = storage
  db.pragma('synchronous = OFF')
  const insertHost = db.prepare('INSERT INTO hosts(id, name, platform, arch, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)')
  const insertProduct = db.prepare('INSERT INTO agent_products(id, name, vendor, homepage) VALUES (?, ?, ?, ?)')
  const insertInstallation = db.prepare('INSERT INTO agent_installations(id, host_id, product_id, version, executable, config_root, data_root, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const insertSession = db.prepare('INSERT INTO logical_sessions(id, installation_id, project_id, workspace_id, title, started_at, ended_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)')
  const insertSourceSession = db.prepare('INSERT INTO source_sessions(id, source_id, installation_id, native_session_id, logical_session_id, native_parent_session_id) VALUES (?, ?, ?, ?, ?, NULL)')
  const insertObservation = db.prepare(`INSERT INTO observations(
    id, host_id, installation_id, project_id, workspace_id, logical_session_id, source_session_id,
    interaction_id, actor_id, kind, source_sequence, canonical_sequence, occurred_at, captured_at, payload_json
  ) VALUES (?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)`)

  db.transaction(() => {
    const createdAt = isoAt(0)
    insertHost.run('host-perf', 'perf-host', process.platform, process.arch, createdAt, createdAt)
    insertProduct.run('product-perf', 'Performance Fixture', 'AgentLens', null)
    insertInstallation.run('installation-perf', 'host-perf', 'product-perf', '1.0.0-alpha.0', null, null, null, createdAt, createdAt)
    for (let sessionIndex = 0; sessionIndex < sessions; sessionIndex += 1) {
      const logicalSessionId = `session-${sessionIndex}`
      const sourceSessionId = `source-session-${sessionIndex}`
      const base = sessionIndex * observationsPerSession
      insertSession.run(logicalSessionId, 'installation-perf', `Session ${sessionIndex}`, isoAt(base), isoAt(base + observationsPerSession - 1))
      insertSourceSession.run(sourceSessionId, 'codex', 'installation-perf', `native-${sessionIndex}`, logicalSessionId)
      for (let index = 0; index < observationsPerSession; index += 1) {
        const sequence = index + 1
        const kind = index === 0 ? 'message.user' : index % 5 === 1 ? 'tool.call' : index % 5 === 2 ? 'tool.result' : 'message.assistant'
        const payload = kind === 'message.user'
          ? { text: `request-${sessionIndex}` }
          : kind === 'tool.result'
            ? { success: true }
            : { text: `payload-${sessionIndex}-${index}` }
        const at = isoAt(base + index)
        insertObservation.run(`obs-${sessionIndex}-${index}`, 'host-perf', 'installation-perf', logicalSessionId, sourceSessionId, kind, sequence, sequence, at, at, JSON.stringify(payload))
      }
    }
  })()
  db.pragma('synchronous = NORMAL')
  const rebuildStarted = performance.now()
  await storage.sessionSummaryProjection.rebuild()
  const elapsed = performance.now() - rebuildStarted

  if (startupMode === 'clean') {
    await storage.checkpoints.set(
      projectionReadinessInternals.CHECKPOINT_SCOPE,
      projectionReadinessInternals.CHECKPOINT_KEY,
      { version: 1, clean: true, markedAt: new Date().toISOString() },
    )
  }
  return elapsed
}

async function waitForHealth(startedAt: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      if (response.ok) return performance.now() - startedAt
    } catch {
      // Daemon has not bound the port yet.
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`health timeout after ${timeoutMs}ms`)
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? null
}

async function probeHealth(): Promise<number> {
  const startedAt = performance.now()
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`health probe returned HTTP ${response.status}`)
  await response.json()
  return performance.now() - startedAt
}

async function waitForExit(child: ChildProcess, timeout = 10_000): Promise<void> {
  if (child.exitCode != null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit)
      reject(new Error('daemon shutdown timeout'))
    }, timeout)
    timer.unref()

    const onExit = () => {
      clearTimeout(timer)
      resolve()
    }
    child.once('exit', onExit)
  })
}

function spawnDaemon(): { child: ChildProcess; output: { value: string } } {
  const output = { value: '' }
  // Windows 的 child.kill 会强制退出；基准通过私有 IPC 触发既有信号处理器，验证正常关闭后的复用。
  const bootstrap = `
    process.on('message', message => {
      if (message !== 'benchmark:shutdown') return
      process.emit('SIGTERM')
      process.disconnect()
    })
    await import('./apps/daemon/src/main.ts')
  `
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', bootstrap], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      AGENT_LENS_DB_PATH: databasePath,
      AGENT_LENS_VAULT_PATH: vaultPath,
      AGENT_LENS_WEB_ROOT: webRoot,
      AGENT_LENS_PORT: String(port),
      AGENT_LENS_DAEMON_MODE: 'managed',
      AGENT_LENS_ENABLED_SOURCES: 'none',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  child.stdout?.on('data', chunk => { output.value += String(chunk) })
  child.stderr?.on('data', chunk => { output.value += String(chunk) })
  return { child, output }
}

async function stopDaemon(child: ChildProcess): Promise<void> {
  if (child.exitCode != null) return
  if (child.connected) child.send('benchmark:shutdown')
  else child.kill('SIGTERM')
  try {
    await waitForExit(child)
  } catch {
    child.kill('SIGKILL')
    await waitForExit(child).catch(() => undefined)
  }
}

async function runStartup(action: 'rebuilt' | 'reused') {
  const { child, output } = spawnDaemon()
  const startedAt = performance.now()
  try {
    const healthReadyMs = await waitForHealth(startedAt)
    const expected = action === 'rebuilt'
      ? 'session summary projection rebuilt'
      : 'session summary projection reused from clean shutdown'
    const deadline = Date.now() + timeoutMs
    const backgroundHealthSamples: number[] = []
    let backgroundHealthFailures = 0
    if (action === 'rebuilt') {
      const startedMarker = 'session summary projection cooperative rebuild started'
      while (!output.value.includes(startedMarker) && Date.now() < deadline) {
        if (child.exitCode != null) throw new Error(`daemon exited early: ${child.exitCode}\n${output.value}`)
        await new Promise(resolve => setTimeout(resolve, 25))
      }
    }
    while (!output.value.includes(expected) && Date.now() < deadline) {
      if (child.exitCode != null) throw new Error(`daemon exited early: ${child.exitCode}\n${output.value}`)
      if (action === 'rebuilt') {
        try {
          backgroundHealthSamples.push(await probeHealth())
        } catch {
          backgroundHealthFailures += 1
        }
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!output.value.includes(expected)) {
      throw new Error(`${action} decision timeout after ${timeoutMs}ms\n${output.value}`)
    }
    const projectionDecisionReadyMs = performance.now() - startedAt
    return {
      action,
      healthReadyMs: Number(healthReadyMs.toFixed(2)),
      projectionDecisionReadyMs: Number(projectionDecisionReadyMs.toFixed(2)),
      backgroundMsAfterHealth: Number((projectionDecisionReadyMs - healthReadyMs).toFixed(2)),
      backgroundHealth: {
        samples: backgroundHealthSamples.length,
        failures: backgroundHealthFailures,
        p95Ms: percentile(backgroundHealthSamples, 0.95) == null
          ? null
          : Number(percentile(backgroundHealthSamples, 0.95)!.toFixed(2)),
        maxMs: backgroundHealthSamples.length === 0
          ? null
          : Number(Math.max(...backgroundHealthSamples).toFixed(2)),
      },
    }
  } finally {
    await stopDaemon(child)
  }
}

try {
  const initialProjectionRebuildMs = await seed()
  await storage.close()

  const startup: Record<string, unknown> = {}
  if (startupMode === 'unclean') {
    startup.unclean = await runStartup('rebuilt')
  } else if (startupMode === 'clean') {
    startup.clean = await runStartup('reused')
  } else {
    startup.unclean = await runStartup('rebuilt')
    startup.clean = await runStartup('reused')
  }

  console.log(JSON.stringify({
    fixture: {
      sessions,
      observations: sessions * observationsPerSession,
      prebuiltProjectionMs: Number(initialProjectionRebuildMs.toFixed(2)),
    },
    mode: startupMode,
    startup,
  }, null, 2))
} finally {
  try { await storage.close() } catch {}
  rmSync(root, { recursive: true, force: true })
}
