$ErrorActionPreference = 'Stop'

$inbox = Join-Path $env:RUNNER_TEMP 'agent-lens-hook-inbox'
New-Item -ItemType Directory -Force -Path $inbox | Out-Null
$env:AGENT_LENS_CLAUDE_INBOX = $inbox

$dispatcherLog = Join-Path $env:RUNNER_TEMP 'agent-lens-hook-dispatcher.log'
Remove-Item -Force $dispatcherLog -ErrorAction SilentlyContinue
$env:AGENT_LENS_HOOK_DISPATCHER_LOG = $dispatcherLog

$agentLensRoot = Join-Path $HOME '.agent-lens/1.0'
$installations = Join-Path $agentLensRoot 'installations'
$dispatcher = Join-Path $agentLensRoot 'runtime/windows-hook-dispatcher.ps1'
$npmRecordPath = Join-Path $installations 'npm.json'
$desktopRecordPath = Join-Path $installations 'desktop.json'

function Show-DispatcherDiagnostics {
  Write-Host '--- 共享 Hook 分发器诊断 ---'
  if (Test-Path $dispatcherLog) { Get-Content -Raw $dispatcherLog | Write-Host }
  else { Write-Host '未生成分发器诊断日志' }

  if (Test-Path $npmRecordPath) {
    Write-Host '--- npm 安装登记 ---'
    Get-Content -Raw $npmRecordPath | Write-Host
  }

  if (Test-Path $desktopRecordPath) {
    Write-Host '--- Desktop 安装登记 ---'
    Get-Content -Raw $desktopRecordPath | Write-Host
  }
}

function Refresh-NpmHookRegistration {
  # hook status 会执行正式 npm provider 登记。CI 没有原生 Codex/Claude
  # 配置，因此 status 非零在这里允许，但不能污染本步骤最终退出码。
  $previousNativePreference = $PSNativeCommandUseErrorActionPreference
  try {
    $PSNativeCommandUseErrorActionPreference = $false
    node dist/cli.mjs hook status all --json | Out-Null
    $registrationExitCode = $LASTEXITCODE
  }
  finally {
    $PSNativeCommandUseErrorActionPreference = $previousNativePreference
  }

  Write-Host "[AgentLens] npm Hook 登记完成，status exit=$registrationExitCode（CI 无原生 Hook 配置时允许非零）"
  $global:LASTEXITCODE = 0
}

Refresh-NpmHookRegistration

if (-not (Test-Path $dispatcher)) { throw '共享 Windows Hook 分发器未安装' }
if (-not (Test-Path $npmRecordPath)) { throw 'npm 安装登记未生成' }

$now = (Get-Date).ToUniversalTime().ToString('o')
$staleDesktop = @{
  schemaVersion = 1
  kind = 'desktop'
  version = 'stale-ci'
  executable = 'C:\missing-agent-lens\AgentLens.exe'
  hookRoot = 'C:\missing-agent-lens\hooks'
  electronRunAsNode = $true
  registeredAt = $now
  updatedAt = $now
} | ConvertTo-Json
$staleDesktop | Set-Content -Encoding UTF8 $desktopRecordPath

# Desktop stale -> valid npm fallback.
$payload = '{"hook_event_name":"PreToolUse","hook_invocation_id":"ci-desktop-stale-npm-valid"}'
$payload | powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $dispatcher agent-lens-hook-claude
if ($LASTEXITCODE -ne 0) { Show-DispatcherDiagnostics; throw '共享 Windows Hook 分发器执行失败' }

$files = @(Get-ChildItem -Path $inbox -Filter '*.json')
if ($files.Count -ne 1) { Show-DispatcherDiagnostics; throw "Desktop 陈旧时 npm 回退没有产生唯一 Inbox 事件，实际：$($files.Count)" }
$captured = Get-Content -Raw $files[0].FullName | ConvertFrom-Json
if ($captured.event.hook_invocation_id -ne 'ci-desktop-stale-npm-valid') { Show-DispatcherDiagnostics; throw 'npm 回退没有完整传递 stdin JSON' }

Remove-Item -Force (Join-Path $inbox '*.json') -ErrorAction SilentlyContinue

# npm stale -> valid Desktop fallback. 使用 CI Node executable + dist/hooks
# 走同一 provider selection 路径；ELECTRON_RUN_AS_NODE 覆盖 Desktop 语义。
$nodeExecutable = (Get-Command node).Source
$hookRoot = (Resolve-Path 'dist/hooks').Path
$validDesktop = @{
  schemaVersion = 1
  kind = 'desktop'
  version = 'desktop-ci'
  executable = $nodeExecutable
  hookRoot = $hookRoot
  electronRunAsNode = $true
  registeredAt = $now
  updatedAt = $now
} | ConvertTo-Json
$validDesktop | Set-Content -Encoding UTF8 $desktopRecordPath

$staleNpm = @{
  schemaVersion = 1
  kind = 'npm'
  version = 'stale-ci'
  executable = 'C:\missing-agent-lens\node.exe'
  hookRoot = 'C:\missing-agent-lens\hooks'
  electronRunAsNode = $false
  registeredAt = $now
  updatedAt = $now
} | ConvertTo-Json
$staleNpm | Set-Content -Encoding UTF8 $npmRecordPath

$payload = '{"hook_event_name":"PreToolUse","hook_invocation_id":"ci-npm-stale-desktop-valid"}'
$payload | powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $dispatcher agent-lens-hook-claude
if ($LASTEXITCODE -ne 0) { Show-DispatcherDiagnostics; throw 'Desktop Provider 回退执行失败' }

$files = @(Get-ChildItem -Path $inbox -Filter '*.json')
if ($files.Count -ne 1) { Show-DispatcherDiagnostics; throw "npm 陈旧时 Desktop 回退没有产生唯一 Inbox 事件，实际：$($files.Count)" }
$captured = Get-Content -Raw $files[0].FullName | ConvertFrom-Json
if ($captured.event.hook_invocation_id -ne 'ci-npm-stale-desktop-valid') { Show-DispatcherDiagnostics; throw 'Desktop 回退没有完整传递 stdin JSON' }

Remove-Item -Force (Join-Path $inbox '*.json') -ErrorAction SilentlyContinue

# Both providers stale -> neutral exit, no Inbox event.
$staleDesktop | Set-Content -Encoding UTF8 $desktopRecordPath
$payload = '{"hook_event_name":"PreToolUse","hook_invocation_id":"ci-both-stale"}'
$payload | powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File $dispatcher agent-lens-hook-claude
if ($LASTEXITCODE -ne 0) { Show-DispatcherDiagnostics; throw 'Provider 全失效时共享分发器没有中性退出' }
$files = @(Get-ChildItem -Path $inbox -Filter '*.json')
if ($files.Count -ne 0) { Show-DispatcherDiagnostics; throw "Provider 全失效时仍产生 Inbox 事件，实际：$($files.Count)" }

# 恢复当前 npm 登记，避免破坏性矩阵污染随后的 lifecycle 集成测试。
Refresh-NpmHookRegistration
if (-not (Test-Path $npmRecordPath)) { Show-DispatcherDiagnostics; throw '共享分发器矩阵结束后 npm 登记未恢复' }
