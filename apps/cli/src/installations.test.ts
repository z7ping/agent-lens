import assert from 'node:assert/strict'
import test from 'node:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  getInstallationStatusSync,
  registerInstallationSync,
} from './installations'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'agent-lens-installations-'))
  return { home }
}

function provider(home: string, name: string) {
  const root = join(home, name)
  const executable = join(root, 'node.exe')
  const hookRoot = join(root, 'hooks')
  mkdirSync(hookRoot, { recursive: true })
  writeFileSync(executable, 'node')
  writeFileSync(join(hookRoot, 'agent-lens-hook-codex.mjs'), 'codex')
  writeFileSync(join(hookRoot, 'agent-lens-hook-claude.mjs'), 'claude')
  return { root, executable, hookRoot }
}

test('安装登记通过真实文件存在性判断是否仍有效', () => {
  const fx = fixture()
  const npm = provider(fx.home, 'npm-v1')
  try {
    registerInstallationSync({
      kind: 'npm',
      version: '1.0.0-test',
      executable: npm.executable,
      hookRoot: npm.hookRoot,
      homeDir: fx.home,
    })
    assert.equal(getInstallationStatusSync('npm', fx.home).valid, true)

    rmSync(npm.hookRoot, { recursive: true, force: true })
    const stale = getInstallationStatusSync('npm', fx.home)
    assert.equal(stale.valid, false)
    assert.match(stale.reason ?? '', /Hook 目录已不存在/)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('升级重新登记新 Provider 并保留首次登记时间', () => {
  const fx = fixture()
  const oldProvider = provider(fx.home, 'npm-v1')
  const newProvider = provider(fx.home, 'npm-v2')
  try {
    const first = registerInstallationSync({
      kind: 'npm',
      version: '1.0.0',
      executable: oldProvider.executable,
      hookRoot: oldProvider.hookRoot,
      homeDir: fx.home,
    })
    const upgraded = registerInstallationSync({
      kind: 'npm',
      version: '1.0.1',
      executable: newProvider.executable,
      hookRoot: newProvider.hookRoot,
      homeDir: fx.home,
    })

    assert.equal(upgraded.registeredAt, first.registeredAt)
    assert.equal(upgraded.version, '1.0.1')
    assert.equal(upgraded.executable, newProvider.executable)
    assert.equal(upgraded.hookRoot, newProvider.hookRoot)

    rmSync(oldProvider.root, { recursive: true, force: true })
    const status = getInstallationStatusSync('npm', fx.home)
    assert.equal(status.valid, true)
    assert.equal(status.record?.version, '1.0.1')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('桌面与 npm 使用独立登记文件', () => {
  const fx = fixture()
  const npm = provider(fx.home, 'npm')
  const desktop = provider(fx.home, 'desktop')
  try {
    registerInstallationSync({
      kind: 'npm', version: 'npm', executable: npm.executable, hookRoot: npm.hookRoot, homeDir: fx.home,
    })
    registerInstallationSync({
      kind: 'desktop', version: 'desktop', executable: desktop.executable, hookRoot: desktop.hookRoot,
      electronRunAsNode: true, homeDir: fx.home,
    })
    assert.equal(getInstallationStatusSync('npm', fx.home).record?.version, 'npm')
    assert.equal(getInstallationStatusSync('desktop', fx.home).record?.version, 'desktop')
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})

test('轮流卸载 Provider 只让对应登记失效且不删除共享数据', () => {
  const fx = fixture()
  const npm = provider(fx.home, 'npm')
  const desktop = provider(fx.home, 'desktop')
  const database = join(fx.home, '.agent-lens', '1.0', 'agent-lens.db')
  mkdirSync(dirname(database), { recursive: true })
  writeFileSync(database, 'shared-data')

  try {
    registerInstallationSync({
      kind: 'npm', version: 'npm', executable: npm.executable, hookRoot: npm.hookRoot, homeDir: fx.home,
    })
    registerInstallationSync({
      kind: 'desktop', version: 'desktop', executable: desktop.executable, hookRoot: desktop.hookRoot,
      electronRunAsNode: true, homeDir: fx.home,
    })

    rmSync(npm.root, { recursive: true, force: true })
    assert.equal(getInstallationStatusSync('npm', fx.home).valid, false)
    assert.equal(getInstallationStatusSync('desktop', fx.home).valid, true)
    assert.equal(existsSync(database), true)

    rmSync(desktop.root, { recursive: true, force: true })
    const npmStatus = getInstallationStatusSync('npm', fx.home)
    const desktopStatus = getInstallationStatusSync('desktop', fx.home)
    assert.equal(npmStatus.valid, false)
    assert.equal(desktopStatus.valid, false)
    assert.notEqual(npmStatus.record, null)
    assert.notEqual(desktopStatus.record, null)
    assert.equal(existsSync(database), true)
  } finally {
    rmSync(fx.home, { recursive: true, force: true })
  }
})
