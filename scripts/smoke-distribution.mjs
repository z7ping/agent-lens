import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const daemon = resolve(root, 'dist', 'daemon.mjs')
const cliEntry = resolve(root, 'dist', 'cli.mjs')
const webRoot = resolve(root, 'dist', 'web')
const temp = await mkdtemp(join(tmpdir(), 'agent-lens-smoke-'))

async function freePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : null
  await new Promise(resolvePromise => server.close(resolvePromise))
  if (!port) throw new Error('Could not allocate a smoke-test port')
  return port
}

function runCli(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: root,
      env: { ...process.env, AGENT_LENS_DISABLE_UPDATE_CHECK: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`CLI exited with ${code}\n${stdout}\n${stderr}`))
    })
  })
}

const port = await freePort()
const child = spawn(process.execPath, [daemon], {
  cwd: root,
  env: {
    ...process.env,
    AGENT_LENS_DB_PATH: join(temp, 'agent-lens.db'),
    AGENT_LENS_PORT: String(port),
    AGENT_LENS_WEB_ROOT: webRoot,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', chunk => { stdout += chunk.toString() })
child.stderr.on('data', chunk => { stderr += chunk.toString() })

async function health() {
  let lastError
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Daemon exited before health check (code ${child.exitCode})\n${stdout}\n${stderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      if (response.ok) return response.json()
      lastError = new Error(`Health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw lastError ?? new Error('Daemon health check did not become ready')
}

try {
  const version = await runCli(['--version'])
  if (version.stdout.trim() !== '1.0.0-alpha.0') {
    throw new Error(`Unexpected CLI version output: ${version.stdout}`)
  }
  const help = await runCli(['--help'])
  if (!help.stdout.includes('agent-lens update --check') || !help.stdout.includes('agent-lens update')) {
    throw new Error(`CLI update help is missing:\n${help.stdout}`)
  }

  const result = await health()
  if (result?.status !== 'ok' || result?.protocolVersion !== '1.0') {
    throw new Error(`Unexpected health response: ${JSON.stringify(result)}`)
  }

  const index = await fetch(`http://127.0.0.1:${port}/`)
  if (!index.ok || !(await index.text()).includes('AgentLens')) {
    throw new Error(`Web surface smoke check failed with status ${index.status}`)
  }

  console.log(`[AgentLens] distribution smoke test passed on port ${port}`)
} finally {
  if (child.exitCode === null) child.kill('SIGTERM')
  await Promise.race([
    new Promise(resolvePromise => child.once('exit', resolvePromise)),
    new Promise(resolvePromise => setTimeout(resolvePromise, 5000)),
  ])
  if (child.exitCode === null) child.kill('SIGKILL')
  await rm(temp, { recursive: true, force: true })
}
