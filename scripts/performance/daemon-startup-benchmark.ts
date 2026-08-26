import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawn } from 'node:child_process'
import { SqliteStorageService } from '../../packages/storage-sqlite/src/index'

function readPositiveInt(name: string, fallback: number): number {
  const prefix = `--${name}=`
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
  if (!raw) return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

const sessions = readPositiveInt('sessions', 100)
const observationsPerSession = readPositiveInt('observations-per-session', 20)
const timeoutMs = readPositiveInt('timeout-ms', 30_000)
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
  return performance.now() - rebuildStarted
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

async function waitForExit(child: ReturnType<typeof spawn>, timeout = 5_000): Promise<void> {
  if (child.exitCode != null) return
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>((resolve, reject) => setTimeout(() => reject(new Error('daemon shutdown timeout')), timeout)),
  ])
}

let child: ReturnType<typeof spawn> | undefined
try {
  const initialProjectionRebuildMs = await seed()
  storage.close()

  let output = ''
  const startedAt = performance.now()
  child = spawn(process.execPath, ['--import', 'tsx', 'apps/daemon/src/main.ts'], {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })

  const healthReadyMs = await waitForHealth(startedAt)
  const deadline = Date.now() + timeoutMs
  while (!output.includes('session summary projection rebuilt') && Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`daemon exited early: ${child.exitCode}\n${output}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!output.includes('session summary projection rebuilt')) {
    throw new Error(`projection rebuild timeout after ${timeoutMs}ms\n${output}`)
  }
  const redundantProjectionReadyMs = performance.now() - startedAt

  console.log(JSON.stringify({
    fixture: {
      sessions,
      observations: sessions * observationsPerSession,
      prebuiltProjectionMs: Number(initialProjectionRebuildMs.toFixed(2)),
    },
    startup: {
      healthReadyMs: Number(healthReadyMs.toFixed(2)),
      redundantProjectionReadyMs: Number(redundantProjectionReadyMs.toFixed(2)),
      redundantBackgroundMsAfterHealth: Number((redundantProjectionReadyMs - healthReadyMs).toFixed(2)),
    },
  }, null, 2))
} finally {
  if (child && child.exitCode == null) {
    child.kill('SIGTERM')
    try {
      await waitForExit(child)
    } catch {
      child.kill('SIGKILL')
      await waitForExit(child).catch(() => undefined)
    }
  }
  try { storage.close() } catch {}
  rmSync(root, { recursive: true, force: true })
}
