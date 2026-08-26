import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createLoginAutostartController } from './login-autostart.mjs'

function fakeApp(initial = {}) {
  let settings = { openAtLogin: false, wasOpenedAtLogin: false, ...initial }
  return {
    isPackaged: true,
    getLoginItemSettings() { return { ...settings } },
    setLoginItemSettings(next) { settings = { ...settings, ...next } },
    read() { return { ...settings } },
  }
}

test('Windows 登录自启保留 --hidden 并可关闭', () => {
  const app = fakeApp()
  const controller = createLoginAutostartController({
    app,
    platform: 'win32',
    execPath: 'C:\\Program Files\\AgentLens\\AgentLens.exe',
    home: 'C:\\Users\\tester',
    env: {},
  })
  assert.equal(controller.isSupported(), true)
  assert.equal(controller.platformLabel(), 'Windows')
  assert.equal(controller.setEnabled(true), true)
  assert.equal(controller.isEnabled(), true)
  assert.deepEqual(app.read().args, ['--hidden'])
  assert.equal(controller.shouldStartHidden(['AgentLens.exe', '--hidden']), true)
  assert.equal(controller.setEnabled(false), true)
})

test('macOS 登录项使用系统登录项并识别登录启动为隐藏启动', () => {
  const app = fakeApp({ wasOpenedAtLogin: true })
  const controller = createLoginAutostartController({
    app,
    platform: 'darwin',
    execPath: '/Applications/AgentLens.app/Contents/MacOS/AgentLens',
    home: '/Users/tester',
    env: {},
  })
  assert.equal(controller.platformLabel(), 'macOS')
  assert.equal(controller.setEnabled(true), true)
  assert.equal(controller.isEnabled(), true)
  assert.equal(controller.shouldStartHidden(['AgentLens']), true)
})

test('Linux 登录自启写入 XDG autostart，并优先登记稳定 APPIMAGE 路径', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agent-lens-login-autostart-'))
  try {
    const app = fakeApp()
    const controller = createLoginAutostartController({
      app,
      platform: 'linux',
      execPath: '/tmp/.mount_AgentLens/agentlens',
      home,
      env: { APPIMAGE: '/home/tester/Applications/AgentLens Latest.AppImage' },
    })
    assert.equal(controller.platformLabel(), 'Linux')
    assert.equal(controller.executable, '/home/tester/Applications/AgentLens Latest.AppImage')
    assert.equal(controller.setEnabled(true), true)
    const source = await readFile(controller.linuxPath, 'utf8')
    assert.match(source, /^\[Desktop Entry\]/)
    assert.match(source, /Name=AgentLens/)
    assert.match(source, /Exec="\/home\/tester\/Applications\/AgentLens Latest\.AppImage" --hidden/)
    assert.match(source, /X-GNOME-Autostart-enabled=true/)
    assert.equal(controller.refreshRegistrationIfEnabled(), true)
    assert.equal(controller.setEnabled(false), true)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('开发态不修改系统登录自启', () => {
  const app = fakeApp()
  app.isPackaged = false
  const controller = createLoginAutostartController({ app, platform: 'linux', execPath: '/tmp/agentlens', home: '/tmp/tester', env: {} })
  assert.equal(controller.isSupported(), false)
  assert.equal(controller.setEnabled(true), false)
})
