import assert from 'node:assert/strict'
import test from 'node:test'
import { launchdPlist, lifecycleInternals, systemdUnit, windowsTaskScript } from './lifecycle'

const options = {
  cliEntry: '/opt/agent-lens/dist/cli.mjs',
  nodePath: '/usr/local/bin/node',
  homeDir: '/home/tester',
  environment: {
    PATH: '/home/tester/.volta/bin:/opt/with&sign/bin:/usr/bin',
    PI_BIN: '/home/tester/.volta/bin/pi',
  },
} as const

test('Windows 后台任务可独立于登录自启注册并继承托管环境', () => {
  const manual = windowsTaskScript({ ...options, platform: 'win32' }, false)
  const autostart = windowsTaskScript({ ...options, platform: 'win32' }, true)
  const command = lifecycleInternals.windowsManagedCommand({ ...options, platform: 'win32' })

  assert.match(manual, /powershell\.exe/)
  assert.match(manual, /WindowStyle Hidden/)
  assert.match(manual, /EncodedCommand/)
  assert.doesNotMatch(manual, /New-ScheduledTaskTrigger/)
  assert.match(autostart, /New-ScheduledTaskTrigger -AtLogOn/)
  assert.match(autostart, /MultipleInstances IgnoreNew/)
  assert.match(command, /\$env:PATH = '\/home\/tester\/\.volta\/bin:\/opt\/with&sign\/bin:\/usr\/bin'/)
  assert.match(command, /\$env:PI_BIN = '\/home\/tester\/\.volta\/bin\/pi'/)
  assert.match(command, /& '\/usr\/local\/bin\/node' '\/opt\/agent-lens\/dist\/cli\.mjs' service run/)
})

test('Windows 后台任务把输出写入有界轮转日志', () => {
  const command = lifecycleInternals.windowsManagedCommand({ ...options, platform: 'win32' })

  assert.match(command, /service\.log/)
  assert.match(command, /service\.log\.1/)
  assert.match(command, /\$maxLogBytes = 2097152/)
  assert.match(command, /2>&1 \| ForEach-Object/)
  assert.match(command, /Move-Item -LiteralPath \$logPath -Destination \$previousLogPath -Force/)
  assert.match(command, /AppendAllText\(\$logPath, \$payload/)
  assert.match(command, /\$agentLensExitCode = \$LASTEXITCODE; exit \$agentLensExitCode/)
})

test('Windows 状态检查能识别隐藏窗口任务定义', () => {
  const script = lifecycleInternals.windowsStatusScript()
  assert.match(script, /WindowStyle\\s\+Hidden/)
  assert.match(script, /hidden = \$hidden/)
})

test('Linux systemd 使用绝对启动入口并继承工具 PATH，不再依赖 WorkingDirectory', () => {
  const unit = systemdUnit({ ...options, platform: 'linux' })
  assert.match(unit, /Environment="PATH=\/home\/tester\/\.volta\/bin:\/opt\/with&sign\/bin:\/usr\/bin"/)
  assert.match(unit, /Environment="PI_BIN=\/home\/tester\/\.volta\/bin\/pi"/)
  assert.match(unit, /ExecStart="\/usr\/local\/bin\/node" "\/opt\/agent-lens\/dist\/cli\.mjs" service run/)
  assert.doesNotMatch(unit, /^WorkingDirectory=/m)
  assert.match(unit, /Restart=on-failure/)
  assert.match(unit, /KillMode=control-group/)
  assert.match(unit, /WantedBy=default\.target/)
})

test('macOS launchd 固化托管环境且不依赖安装目录作为工作目录', () => {
  const disabled = launchdPlist({ ...options, platform: 'darwin' }, false)
  const enabled = launchdPlist({ ...options, platform: 'darwin' }, true)

  assert.match(disabled, /<key>RunAtLoad<\/key>\s+<false\/>/)
  assert.match(enabled, /<key>RunAtLoad<\/key>\s+<true\/>/)
  assert.match(enabled, /<string>service<\/string>\s+<string>run<\/string>/)
  assert.match(enabled, /<key>EnvironmentVariables<\/key>/)
  assert.match(enabled, /<key>PATH<\/key>\s+<string>\/home\/tester\/\.volta\/bin:\/opt\/with&amp;sign\/bin:\/usr\/bin<\/string>/)
  assert.match(enabled, /<key>PI_BIN<\/key>\s+<string>\/home\/tester\/\.volta\/bin\/pi<\/string>/)
  assert.doesNotMatch(enabled, /<key>WorkingDirectory<\/key>/)
  assert.match(enabled, /<key>SuccessfulExit<\/key>\s+<false\/>/)
})
