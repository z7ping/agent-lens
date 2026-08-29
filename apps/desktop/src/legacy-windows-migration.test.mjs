import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import {
  isLegacyAppInfo,
  isLegacyStartupContent,
  legacyWindowsMigrationInternals,
  legacyWindowsPaths,
  looksLikeLegacyProcess,
  migrateLegacyWindowsRuntime,
} from './legacy-windows-migration.mjs'

test('legacyWindowsPaths matches the 0.x Windows installed layout', () => {
  const paths = legacyWindowsPaths({
    homeDir: 'C:\\Users\\tester',
    appData: 'C:\\Users\\tester\\AppData\\Roaming',
  })

  assert.equal(paths.legacyInstallDir, 'C:\\Users\\tester\\.agent-lens\\app')
  assert.equal(paths.legacyPackagePath, 'C:\\Users\\tester\\.agent-lens\\app\\package.json')
  assert.equal(paths.legacyPidFile, 'C:\\Users\\tester\\.agent-lens\\run\\server.pid')
  assert.equal(
    paths.legacyStartupFile,
    'C:\\Users\\tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\AgentLens.vbs',
  )
})

test('isLegacyAppInfo only accepts AgentLens 0.x app-info responses', () => {
  assert.equal(isLegacyAppInfo({ name: '@z7ping/agent-lens', version: '0.7.0' }), true)
  assert.equal(isLegacyAppInfo({ name: '@z7ping/agent-lens', version: '0.6.2' }), true)
  assert.equal(isLegacyAppInfo({ name: '@z7ping/agent-lens', version: '1.0.0-alpha.1' }), false)
  assert.equal(isLegacyAppInfo({ name: 'another-service', version: '0.7.0' }), false)
  assert.equal(isLegacyAppInfo(null), false)
})

test('readLegacyAppInfo rejects non-AgentLens and 1.x HTTP identities', async () => {
  const response = info => async () => ({ ok: true, json: async () => info })
  assert.deepEqual(
    await legacyWindowsMigrationInternals.readLegacyAppInfo(56789, response({ name: '@z7ping/agent-lens', version: '0.7.0' })),
    { name: '@z7ping/agent-lens', version: '0.7.0' },
  )
  assert.equal(
    await legacyWindowsMigrationInternals.readLegacyAppInfo(56789, response({ name: '@z7ping/agent-lens', version: '1.0.0-alpha.1' })),
    null,
  )
  assert.equal(
    await legacyWindowsMigrationInternals.readLegacyAppInfo(56789, response({ name: 'other-service', version: '0.7.0' })),
    null,
  )
})

test('looksLikeLegacyProcess requires the known 0.x install directory and server entry', () => {
  const legacyInstallDir = 'C:\\Users\\tester\\.agent-lens\\app'
  assert.equal(looksLikeLegacyProcess({
    processId: 1234,
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\.agent-lens\\app\\server.js" 56789 --daemon',
  }, legacyInstallDir), true)

  assert.equal(looksLikeLegacyProcess({
    processId: 1235,
    commandLine: '"C:/Program Files/nodejs/node.exe" "C:/Users/tester/.agent-lens/app/server.js" 56789 --daemon',
  }, legacyInstallDir), true)

  assert.equal(looksLikeLegacyProcess({
    processId: 5678,
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "D:\\other\\server.js" 56789',
  }, legacyInstallDir), false)

  assert.equal(looksLikeLegacyProcess({
    processId: 5679,
    commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\tester\\.agent-lens\\app\\worker.js"',
  }, legacyInstallDir), false)
})

test('isLegacyStartupContent only removes the AgentLens 0.x VBS startup entry', () => {
  const legacyInstallDir = 'C:\\Users\\tester\\.agent-lens\\app'
  const owned = [
    'Set objShell = CreateObject("WScript.Shell")',
    'objShell.Run "\\"C:\\Program Files\\nodejs\\node.exe\\" \\"C:\\Users\\tester\\.agent-lens\\app\\server.js\\" 56789 --daemon", 0, False',
  ].join('\r\n')

  assert.equal(isLegacyStartupContent(owned, legacyInstallDir), true)
  assert.equal(isLegacyStartupContent('objShell.Run "C:\\Tools\\other-server.js"', legacyInstallDir), false)
})

async function reservePort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配迁移集成测试端口')
  const port = address.port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForLegacyServer(port) {
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/app-info`, { signal: AbortSignal.timeout(500) })
      if (response.ok) return
    } catch {
      // Child process may still be binding the port.
    }
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error('0.x 迁移集成测试服务未按时启动')
}

test('Windows migration retires a real 0.x listener and its VBS startup entry', { skip: process.platform !== 'win32', timeout: 20_000 }, async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'agent-lens-legacy-migration-'))
  const homeDir = join(sandbox, 'home')
  const appData = join(sandbox, 'appdata')
  const paths = legacyWindowsPaths({ homeDir, appData })
  const port = await reservePort()
  let child = null

  try {
    await mkdir(paths.legacyInstallDir, { recursive: true })
    await mkdir(join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true })
    await writeFile(paths.legacyPackagePath, JSON.stringify({ name: '@z7ping/agent-lens', version: '0.7.0' }), 'utf8')
    await writeFile(paths.legacyServerPath, [
      "const http = require('node:http')",
      'const port = Number(process.argv[2])',
      "http.createServer((req, res) => {",
      "  if (req.url === '/api/app-info') {",
      "    res.setHeader('content-type', 'application/json')",
      "    res.end(JSON.stringify({ name: '@z7ping/agent-lens', version: '0.7.0' }))",
      '    return',
      '  }',
      "  res.statusCode = 404",
      "  res.end('not found')",
      "}).listen(port, '127.0.0.1')",
    ].join('\n'), 'utf8')
    await writeFile(paths.legacyStartupFile, [
      'Set objShell = CreateObject("WScript.Shell")',
      `objShell.Run "\\"${process.execPath}\\" \\"${paths.legacyServerPath}\\" ${port} --daemon", 0, False`,
    ].join('\r\n'), 'utf8')

    child = spawn(process.execPath, [paths.legacyServerPath, String(port), '--daemon'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    await waitForLegacyServer(port)

    const result = await migrateLegacyWindowsRuntime({ port, homeDir, appData })
    assert.equal(result.changed, true)
    assert.equal(result.legacyVersion, '0.7.0')
    assert.equal(result.removedStartup, true)
    assert.equal(result.stoppedPids.includes(child.pid), true)
    assert.equal(existsSync(paths.legacyStartupFile), false)
    assert.equal(existsSync(paths.markerFile), true)

    const marker = JSON.parse(await readFile(paths.markerFile, 'utf8'))
    assert.equal(marker.legacyVersion, '0.7.0')
    assert.equal(marker.removedStartup, true)
    assert.equal(marker.stoppedPids.includes(child.pid), true)

    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/app-info`, { signal: AbortSignal.timeout(400) }),
    )
  } finally {
    if (child?.exitCode === null) child.kill('SIGKILL')
    await rm(sandbox, { recursive: true, force: true })
  }
})
