import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getInstallationStatusSync,
  registerInstallationSync,
} from './installations'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-lens-installations-'))
  const executable = join(home, 'node.exe')
  const hookRoot = join(home, 'hooks')
  mkdirSync(hookRoot, { recursive: true })
  writeFileSync(executable, 'node')
  writeFileSync(join(hookRoot, 'agent-lens-hook-codex.mjs'), 'codex')
  writeFileSync(join(hookRoot, 'agent-lens-hook-claude.mjs'), 'claude')
  return { home, executable, hookRoot }
}

test('安装登记通过真实文件存在性判断是否仍有效', () => {
  const fx = fixture()
  try {
    registerInstallationSync({
      kind: 'npm',
      version: '1.0.0-test',
      executable: fx.executable,
      hookRoot: fx.hookRoot,
      homeDir: fx.home,
    })
    assert.equal(getInstallationStatusSync('npm', fx.home).valid, true)

    rmSync(fx.hookRoot, { recursive: true, force: true })
    const stale = getInstallationStatusSync('npm', fx.home)
    assert.equal(stale.valid, false)
    assert.match(stale.reason ?? '', /Hook 目录已不存在/)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('桌面与 npm 使用独立登记文件', () => {
  const fx = fixture()
  try {
    registerInstallationSync({
      kind: 'npm', version: 'npm', executable: fx.executable, hookRoot: fx.hookRoot, homeDir: fx.home,
    })
    registerInstallationSync({
      kind: 'desktop', version: 'desktop', executable: fx.executable, hookRoot: fx.hookRoot,
      electronRunAsNode: true, homeDir: fx.home,
    })
    assert.equal(getInstallationStatusSync('npm', fx.home).record?.version, 'npm')
    assert.equal(getInstallationStatusSync('desktop', fx.home).record?.version, 'desktop')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})
