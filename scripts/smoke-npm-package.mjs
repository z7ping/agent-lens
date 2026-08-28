import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const temp = await mkdtemp(join(tmpdir(), 'agent-lens-npm-smoke-'))
const packDir = join(temp, 'pack')
const consumer = join(temp, 'consumer')

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, AGENT_LENS_DISABLE_UPDATE_CHECK: '1', ...(options.env ?? {}) },
      shell: options.shell ?? false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stdout}\n${stderr}`))
    })
  })
}

async function freePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = address && typeof address !== 'string' ? address.port : null
  await new Promise(resolvePromise => server.close(resolvePromise))
  if (!port) throw new Error('Could not allocate npm smoke-test port')
  return port
}

async function resolveTarball() {
  const requested = process.argv[2]
  if (requested) return isAbsolute(requested) ? requested : resolve(root, requested)

  await mkdir(packDir, { recursive: true })
  await run(npmCommand, ['pack', '--pack-destination', packDir], {
    shell: process.platform === 'win32',
  })
  const tarballs = (await readdir(packDir)).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`Expected exactly one npm tarball, found ${tarballs.length}: ${tarballs.join(', ')}`)
  }
  return join(packDir, tarballs[0])
}

let daemon
let daemonStdout = ''
let daemonStderr = ''

try {
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const tarball = await resolveTarball()

  await mkdir(consumer, { recursive: true })
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'agent-lens-npm-smoke-consumer',
    version: '0.0.0',
    private: true,
  }, null, 2)}\n`)

  await run(npmCommand, ['install', '--no-audit', '--no-fund', tarball], {
    cwd: consumer,
    shell: process.platform === 'win32',
  })

  const installedRoot = join(consumer, 'node_modules', '@z7ping', 'agent-lens')
  const installedPackage = JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8'))
  if (installedPackage.version !== rootPackage.version) {
    throw new Error(`Installed npm package version ${installedPackage.version} != ${rootPackage.version}`)
  }

  const bin = process.platform === 'win32'
    ? join(consumer, 'node_modules', '.bin', 'agent-lens.cmd')
    : join(consumer, 'node_modules', '.bin', 'agent-lens')
  const version = await run(bin, ['--version'], {
    cwd: consumer,
    shell: process.platform === 'win32',
  })
  if (version.stdout.trim() !== rootPackage.version) {
    throw new Error(`Installed npm CLI version output was ${JSON.stringify(version.stdout.trim())}, expected ${rootPackage.version}`)
  }

  const help = await run(bin, ['--help'], {
    cwd: consumer,
    shell: process.platform === 'win32',
  })
  if (!help.stdout.includes('agent-lens')) {
    throw new Error(`Installed npm CLI help is invalid:\n${help.stdout}\n${help.stderr}`)
  }

  const port = await freePort()
  const daemonEntry = join(installedRoot, 'dist', 'daemon.mjs')
  const webRoot = join(installedRoot, 'dist', 'web')
  daemon = spawn(process.execPath, [daemonEntry], {
    cwd: consumer,
    env: {
      ...process.env,
      AGENT_LENS_DISABLE_UPDATE_CHECK: '1',
      AGENT_LENS_DB_PATH: join(temp, 'agent-lens.db'),
      AGENT_LENS_PORT: String(port),
      AGENT_LENS_WEB_ROOT: webRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.on('data', chunk => { daemonStdout += chunk.toString() })
  daemon.stderr.on('data', chunk => { daemonStderr += chunk.toString() })

  let health
  let lastError
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (daemon.exitCode !== null) {
      throw new Error(`Installed npm daemon exited early (${daemon.exitCode})\n${daemonStdout}\n${daemonStderr}`)
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
      if (response.ok) {
        health = await response.json()
        break
      }
      lastError = new Error(`Health returned ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  if (!health) throw lastError ?? new Error('Installed npm daemon did not become healthy')
  if (health.status !== 'ok' || health.protocolVersion !== '1.0') {
    throw new Error(`Unexpected installed npm health response: ${JSON.stringify(health)}`)
  }

  const index = await fetch(`http://127.0.0.1:${port}/`)
  if (!index.ok || !(await index.text()).includes('AgentLens')) {
    throw new Error(`Installed npm Web surface failed with status ${index.status}`)
  }

  console.log(`[AgentLens] npm tarball install smoke passed on ${process.platform}/${process.arch}: ${rootPackage.version}`)
} finally {
  if (daemon && daemon.exitCode === null) daemon.kill('SIGTERM')
  if (daemon) {
    await Promise.race([
      new Promise(resolvePromise => daemon.once('exit', resolvePromise)),
      new Promise(resolvePromise => setTimeout(resolvePromise, 5000)),
    ])
    if (daemon.exitCode === null) daemon.kill('SIGKILL')
  }
  await rm(temp, { recursive: true, force: true })
}
