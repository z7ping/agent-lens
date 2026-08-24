import assert from 'node:assert/strict'
import test from 'node:test'
import { launchdPlist, systemdUnit, windowsStatusScript, windowsTaskScript } from './lifecycle'

const options = {
  cliEntry: '/opt/agent-lens/dist/cli.mjs',
  nodePath: '/usr/local/bin/node',
  homeDir: '/home/tester',
} as const

test('Windows 后台任务可独立于登录自启注册且隐藏控制台窗口', () => {
  const manual = windowsTaskScript({ ...options, platform: 'win32' }, false)
  const autostart = windowsTaskScript({ ...options, platform: 'win32' }, true)

  assert.match(manual, /powershell\.exe/)
  assert.match(manual, /WindowStyle Hidden/)
  assert.match(manual, /\/usr\/local\/bin\/node/)
  assert.match(manual, /service run/)
  assert.doesNotMatch(manual, /New-ScheduledTaskTrigger/)
  assert.match(autostart, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.match(autostart, /MultipleInstances IgnoreNew/)
})

test('Windows 状态检查能识别隐藏窗口任务定义', () => {
  const script = windowsStatusScript()
  assert.match(script, /WindowStyle\\s\+Hidden/)
  assert.match(script, /hidden = \$hidden/)
})

test('Linux 使用 systemd 用户服务且由系统管理进程组', () => {
  const unit = systemdUnit({ ...options, platform: 'linux' })
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/agent-lens\/dist\/cli\.mjs" service run/)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /KillMode=control-group/)
  assert.match(unit, /WantedBy=default\.target/)
})

test('macOS launchd 将登录自启作为独立开关', () => {
  const disabled = launchdPlist({ ...options, platform: 'darwin' }, false)
  const enabled = launchdPlist({ ...options, platform: 'darwin' }, true)

  assert.match(disabled, /<key>RunAtLoad<\/key>\s+<false\/>/)
  assert.match(enabled, /<key>RunAtLoad<\/key>\s+<true\/>/)
  assert.match(enabled, /<string>service<\/string>\s+<string>run<\/string>/)
  assert.match(enabled, /<key>SuccessfulExit<\/key>\s+<false\/>/)
})
