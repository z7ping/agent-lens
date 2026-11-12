import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveDirectExecutableCommand, resolveExecutable, resolveManagedExecutableTarget, resolveWindowsNpmShimTarget } from './executable-discovery'

test('Windows npm 启动脚本支持原生入口，并优先识别 JavaScript 入口而不是 Node 解释器', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-npm-target-'))
  try {
    const native = join(root, 'tool.exe')
    const script = join(root, 'cli.js')
    const shim = join(root, 'tool.cmd')
    await writeFile(native, '')
    await writeFile(script, '')
    await writeFile(join(root, 'node.exe'), '')
    await writeFile(shim, '@ECHO off\n"%dp0%\\tool.exe" %*\n')
    assert.equal(await resolveWindowsNpmShimTarget(shim), native)
    await writeFile(shim, '@ECHO off\n"%~dp0node.exe" "%dp0%\\cli.js" %*\n')
    assert.equal(await resolveWindowsNpmShimTarget(shim), script)
    await writeFile(shim, '@ECHO off\n"%dp0%\\missing.exe" %*\n')
    assert.equal(await resolveWindowsNpmShimTarget(shim), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('POSIX 后台 PATH 缺少工具时可从登录 Shell PATH 找到可执行文件', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-executable-discovery-'))
  try {
    const executable = join(root, 'pi')
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(executable, 0o755)

    const found = await resolveExecutable('pi', {
      platform: process.platform,
      pathValue: '/agent-lens/restricted-path',
      shellPathResolver: async () => `${root}:/usr/bin:/bin`,
    })

    assert.equal(found, executable)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('显式可执行文件优先于 PATH 和登录 Shell', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-executable-explicit-'))
  try {
    const executable = join(root, 'pi-explicit')
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(executable, 0o755)

    const found = await resolveExecutable('pi', {
      explicit: executable,
      platform: process.platform,
      pathValue: '/agent-lens/restricted-path',
      shellPathResolver: async () => '/another/path',
    })

    assert.equal(found, executable)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows PATH 优先选用 PATHEXT 入口，不把 npm 的无扩展名 shim 当作 CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-executable-windows-npm-shim-'))
  try {
    const bareShim = join(root, 'pi')
    const commandShim = join(root, 'pi.cmd')
    await writeFile(bareShim, '#!/bin/sh\nexit 0\n', 'utf8')
    await writeFile(commandShim, '@echo off\r\nexit /b 0\r\n', 'utf8')

    const found = await resolveExecutable('pi', { platform: 'win32', pathValue: root })
    assert.equal(found, commandShim)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('单次 shim 目标解析共享登录 Shell PATH，不为每个管理器重复启动 Shell', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-executable-managed-'))
  try {
    const executable = join(root, 'pi')
    await writeFile(executable, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(executable, 0o755)
    let shellCalls = 0

    const resolved = await resolveManagedExecutableTarget('pi', executable, {
      platform: process.platform,
      pathValue: '/agent-lens/restricted-path',
      shellPathResolver: async () => {
        shellCalls += 1
        return root
      },
    })

    assert.equal(resolved, await realpath(executable))
    assert.equal(shellCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows CLI 启动不会退回 cmd.exe；npm shim 与原生 exe 均直接执行', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-lens-direct-cli-'))
  try {
    const script = join(root, 'codex.js')
    const native = join(root, 'codex.exe')
    const shim = join(root, 'codex.cmd')
    await writeFile(script, '')
    await writeFile(native, '')
    await writeFile(shim, '@ECHO off\r\n"%~dp0node.exe" "%~dp0codex.js" %*\r\n')
    assert.deepEqual(
      await resolveDirectExecutableCommand('codex', shim, ['app-server'], { platform: 'win32', pathValue: root }),
      { command: process.execPath, args: [script, 'app-server'] },
    )
    assert.deepEqual(
      await resolveDirectExecutableCommand('codex', native, ['app-server'], { platform: 'win32', pathValue: root }),
      { command: native, args: ['app-server'] },
    )
    await writeFile(shim, '@ECHO off\r\nunsupported-wrapper %*\r\n')
    assert.equal(
      await resolveDirectExecutableCommand('codex', shim, ['app-server'], { platform: 'win32', pathValue: root }),
      undefined,
      'an unknown cmd shim must never be passed to spawn with shell:true',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
