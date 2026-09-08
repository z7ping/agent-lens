import assert from 'node:assert/strict'
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveExecutable, resolveManagedExecutableTarget } from './executable-discovery'

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
