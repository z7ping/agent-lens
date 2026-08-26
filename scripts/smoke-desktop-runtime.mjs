import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const executable = process.argv[2]
if (!executable) {
  throw new Error('用法：node scripts/smoke-desktop-runtime.mjs <packaged-executable>')
}

const resolvedExecutable = resolve(executable)
if (!existsSync(resolvedExecutable)) {
  throw new Error(`桌面可执行文件不存在：${resolvedExecutable}`)
}

const resourcesDir = process.platform === 'darwin'
  ? resolve(dirname(resolvedExecutable), '..', 'Resources')
  : resolve(dirname(resolvedExecutable), 'resources')
const daemonEntry = join(resourcesDir, 'app.asar.unpacked', 'runtime', 'daemon.mjs')
if (!existsSync(daemonEntry)) {
  throw new Error(`桌面包缺少运行时：${daemonEntry}`)
}

const smokeRoot = await mkdtemp(join(tmpdir(), 'agent-lens-desktop-runtime-'))
const port = 58000 + Math.floor(Math.random() * 1000)
const child = spawn(resolvedExecutable, [daemonEntry], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    AGENT_LENS_DAEMON_MODE: 'managed',
    AGENT_LENS_RUNTIME_OWNER: 'desktop',
    AGENT_LENS_PORT: String(port),
    AGENT_LENS_DB_PATH: join(smokeRoot, 'agent-lens.db'),
    AGENT_LENS_VAULT_PATH: join(smokeRoot, 'vault'),
    AGENT_LENS_ENABLED_SOURCES: 'none',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout?.on('data', chunk => { stdout += chunk })
child.stderr?.on('data', chunk => { stderr += chunk })

try {
  const deadline = Date.now() + 30_000
  let health = null
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`打包运行时在 Health 就绪前退出：${child.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
        signal: AbortSignal.timeout(1000),
      })
      if (response.ok || response.status === 503) {
        health = await response.json()
        break
      }
    } catch {
      // Retry until the deadline.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }

  if (!health) {
    throw new Error(`桌面包运行时在 30 秒内没有提供 Health 响应\nstdout:\n${stdout}\nstderr:\n${stderr}`)
  }
  if (String(health.protocolVersion) !== '1.0') {
    throw new Error(`桌面包 Protocol 不匹配：${String(health.protocolVersion)}`)
  }
  if (String(health.runtime?.owner) !== 'desktop') {
    throw new Error(`桌面包运行时所有者不是 desktop：${String(health.runtime?.owner)}`)
  }

  console.log(`[AgentLens] ${process.platform}/${process.arch} 桌面包运行时冒烟通过：pid=${child.pid}, port=${port}`)
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([
      new Promise(resolvePromise => child.once('exit', resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 2500)),
    ])
  }
  if (child.exitCode === null) child.kill('SIGKILL')
  await rm(smokeRoot, { recursive: true, force: true })
}
