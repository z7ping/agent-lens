import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  resolveInstalledPiSdk,
  resolveWindowsNpmShimNodeEntry,
} from './sdk-loader'

async function createFakeOfficialPiPackage(root: string): Promise<{
  packageRoot: string
  cliEntry: string
  sdkEntry: string
}> {
  const packageRoot = join(root, 'node_modules', '@earendil-works', 'pi-coding-agent')
  const cliEntry = join(packageRoot, 'dist', 'bundle', 'cli.js')
  const sdkEntry = join(packageRoot, 'dist', 'index.js')
  await mkdir(join(packageRoot, 'dist', 'bundle'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '0.0.0-test',
      type: 'module',
      main: './dist/index.js',
    }),
    'utf8',
  )
  await writeFile(cliEntry, 'export {}\n', 'utf8')
  await writeFile(sdkEntry, 'export async function createAgentSession(){}; export class SessionManager {}\n', 'utf8')
  return { packageRoot, cliEntry, sdkEntry }
}

test('Windows npm pi.cmd 定位同一官方 npm 包里的 SDK，而不是重新 spawn RPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-sdk-shim-'))
  try {
    const pkg = await createFakeOfficialPiPackage(root)
    const shim = join(root, 'pi.cmd')
    await writeFile(
      shim,
      '@echo off\r\nnode "%~dp0node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n',
      'utf8',
    )

    assert.equal(await resolveWindowsNpmShimNodeEntry(shim), pkg.cliEntry)
    const resolved = await resolveInstalledPiSdk(shim, 'win32')
    assert.equal(resolved?.packageRoot, pkg.packageRoot)
    assert.equal(resolved?.sdkEntry, pkg.sdkEntry)
    assert.equal(resolved?.version, '0.0.0-test')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('直接位于官方 Pi 包内的 CLI 入口可回溯到 SDK 主入口', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-pi-sdk-direct-'))
  try {
    const pkg = await createFakeOfficialPiPackage(root)
    const resolved = await resolveInstalledPiSdk(pkg.cliEntry, process.platform)
    assert.equal(resolved?.packageRoot, await realpath(pkg.packageRoot))
    assert.equal(resolved?.sdkEntry, await realpath(pkg.sdkEntry))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
