$ErrorActionPreference = 'Stop'

try {
  node dist/cli.mjs autostart enable
  if ($LASTEXITCODE -ne 0) { throw '启用登录自启失败' }

  node dist/cli.mjs service start
  if ($LASTEXITCODE -ne 0) { throw '启动 npm 后台服务失败' }

  $status = node dist/cli.mjs status --json | ConvertFrom-Json
  if (-not $status.online) { throw '后台服务启动后 Health 仍离线' }
  if ($status.owner -ne 'service') { throw "运行时所有者不是 service：$($status.owner)" }
  if (-not $status.lifecycle.registered) { throw 'Windows 后台任务未注册' }
  if (-not $status.lifecycle.active) { throw 'Windows 后台任务未运行' }
  if (-not $status.lifecycle.autostart) { throw 'Windows 登录自启未保留' }
  if (-not $status.lifecycle.hidden) { throw 'Windows 后台任务没有使用隐藏窗口定义' }

  $doctor = node dist/cli.mjs doctor --json | ConvertFrom-Json
  $lifecycleCheck = $doctor.checks | Where-Object { $_.id -eq 'lifecycle' }
  if ($null -eq $lifecycleCheck) { throw 'doctor 缺少 lifecycle 检查' }
  if ($lifecycleCheck.level -ne 'pass') { throw "doctor lifecycle 未通过：$($lifecycleCheck.detail)" }

  $hookRunnerCheck = $doctor.checks | Where-Object { $_.id -eq 'windows-hook-runner' }
  if ($null -eq $hookRunnerCheck) { throw 'doctor 缺少 Windows Hook 启动器检查' }
  if ($hookRunnerCheck.level -ne 'pass') { throw "Windows Hook 启动器检查未通过：$($hookRunnerCheck.detail)" }

  # A restart must wait for the previous service-owned Daemon to exit before
  # starting another managed process.
  node dist/cli.mjs service restart
  if ($LASTEXITCODE -ne 0) { throw '重启 npm 后台服务失败：旧 Daemon 未退出或新服务未就绪' }
  $restarted = node dist/cli.mjs status --json | ConvertFrom-Json
  if (-not $restarted.online -or $restarted.owner -ne 'service' -or -not $restarted.lifecycle.active) {
    throw '重启后 Windows 计划任务与服务持有的 Daemon 未同时就绪'
  }

  # Stop must terminate both the scheduled task and its service-owned daemon.
  # A detached launcher can otherwise pass the start/health assertions.
  node dist/cli.mjs service stop
  if ($LASTEXITCODE -ne 0) { throw '停止 npm 后台服务失败：计划任务或 Daemon 仍在运行' }
  $stopped = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $stopStatus = node dist/cli.mjs status --json | ConvertFrom-Json
    if (-not $stopStatus.lifecycle.active -and
        -not ($stopStatus.online -and $stopStatus.owner -eq 'service')) {
      $stopped = $true
      break
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $stopped) { throw '停止后台任务后仍存在服务持有的 Daemon 或运行中计划任务' }
}
finally {
  node dist/cli.mjs service stop
  node dist/cli.mjs autostart disable
}
