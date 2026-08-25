param(
  [string]$ExecutablePath = 'release/windows/win-unpacked/AgentLens.exe'
)

$ErrorActionPreference = 'Stop'

$resolved = (Resolve-Path $ExecutablePath).Path
$port = Get-Random -Minimum 57000 -Maximum 57999
$smokeRoot = Join-Path $env:RUNNER_TEMP ("agent-lens-desktop-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null

$previous = @{
  AGENT_LENS_PORT = $env:AGENT_LENS_PORT
  AGENT_LENS_DB_PATH = $env:AGENT_LENS_DB_PATH
  AGENT_LENS_VAULT_PATH = $env:AGENT_LENS_VAULT_PATH
  AGENT_LENS_ENABLED_SOURCES = $env:AGENT_LENS_ENABLED_SOURCES
}

$env:AGENT_LENS_PORT = [string]$port
$env:AGENT_LENS_DB_PATH = Join-Path $smokeRoot 'agent-lens.db'
$env:AGENT_LENS_VAULT_PATH = Join-Path $smokeRoot 'vault'
$env:AGENT_LENS_ENABLED_SOURCES = 'none'

$process = $null
try {
  Write-Host "[AgentLens] 按双击等价方式启动打包客户端：$resolved"
  $process = Start-Process -FilePath $resolved -PassThru
  $health = $null
  $deadline = (Get-Date).AddSeconds(30)

  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
      throw "AgentLens.exe 在 Health 就绪前退出，退出码：$($process.ExitCode)"
    }

    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/v1/health" -TimeoutSec 1
      if ($null -ne $health) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }

  if ($null -eq $health) {
    throw '打包后的 AgentLens.exe 在 30 秒内没有提供 Health 响应'
  }
  if ([string]$health.protocolVersion -ne '1.0') {
    throw "打包客户端 Protocol 不匹配：$($health.protocolVersion)"
  }
  if ([string]$health.runtime.owner -ne 'desktop') {
    throw "打包客户端运行时所有者不是 desktop：$($health.runtime.owner)"
  }

  Write-Host "[AgentLens] Windows 打包客户端启动冒烟通过：pid=$($process.Id), port=$port"
}
finally {
  if ($null -ne $process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F | Out-Null
  }
  foreach ($key in $previous.Keys) {
    if ($null -eq $previous[$key]) {
      Remove-Item "Env:$key" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$key" $previous[$key]
    }
  }
  Remove-Item -Recurse -Force $smokeRoot -ErrorAction SilentlyContinue
}
