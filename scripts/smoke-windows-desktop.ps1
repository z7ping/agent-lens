param(
  [string]$ExecutablePath = 'release/windows/win-unpacked/AgentLens.exe'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$resolved = (Resolve-Path $ExecutablePath).Path
$port = Get-Random -Minimum 57000 -Maximum 57999
$smokeRoot = Join-Path $env:RUNNER_TEMP ("agent-lens-desktop-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
$desktopStdout = Join-Path $smokeRoot 'desktop.stdout.log'
$desktopStderr = Join-Path $smokeRoot 'desktop.stderr.log'
$desktopBootLog = Join-Path $smokeRoot 'desktop.boot.log'

function Assert-EmbeddedIconVisible([string]$path) {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($path)
  if ($null -eq $icon) { throw 'AgentLens.exe 没有可提取的 Windows 应用图标' }

  $bitmap = $null
  try {
    $bitmap = $icon.ToBitmap()
    if ($bitmap.Width -lt 16 -or $bitmap.Height -lt 16) {
      throw "AgentLens.exe 内嵌图标尺寸异常：$($bitmap.Width)x$($bitmap.Height)"
    }

    $opaqueSamples = 0
    $colors = [System.Collections.Generic.HashSet[string]]::new()
    $stepX = [Math]::Max(1, [Math]::Floor($bitmap.Width / 16))
    $stepY = [Math]::Max(1, [Math]::Floor($bitmap.Height / 16))
    for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
      for ($y = 0; $y -lt $bitmap.Height; $y += $stepY) {
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.A -gt 0) { $opaqueSamples += 1 }
        [void]$colors.Add("$($pixel.A),$($pixel.R),$($pixel.G),$($pixel.B)")
      }
    }

    if ($opaqueSamples -eq 0) { throw 'AgentLens.exe 内嵌图标采样结果全部透明' }
    if ($colors.Count -lt 2) { throw 'AgentLens.exe 内嵌图标采样结果为单色空图' }
    Write-Host "[AgentLens] Windows EXE 图标检查通过：$($bitmap.Width)x$($bitmap.Height)，采样颜色=$($colors.Count)"
  }
  finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    $icon.Dispose()
  }
}

function Write-DesktopDiagnostics {
  Write-Host '[AgentLens] 桌面启动失败，输出可用运行日志：'
  foreach ($candidate in @($desktopBootLog, $desktopStdout, $desktopStderr)) {
    if (Test-Path -LiteralPath $candidate) {
      Write-Host "--- $candidate ---"
      Get-Content -LiteralPath $candidate -Tail 200 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }
  }
  $logs = @(Get-ChildItem -Path $env:APPDATA -Filter 'daemon.log' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 5)
  if ($logs.Count -eq 0) {
    Write-Host '[AgentLens] 未找到 daemon.log'
    return
  }
  foreach ($log in $logs) {
    Write-Host "--- $($log.FullName) ---"
    Get-Content -LiteralPath $log.FullName -Tail 200 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  }
}

Assert-EmbeddedIconVisible $resolved

$previous = @{
  AGENT_LENS_PORT = $env:AGENT_LENS_PORT
  AGENT_LENS_DB_PATH = $env:AGENT_LENS_DB_PATH
  AGENT_LENS_VAULT_PATH = $env:AGENT_LENS_VAULT_PATH
  AGENT_LENS_ENABLED_SOURCES = $env:AGENT_LENS_ENABLED_SOURCES
  AGENT_LENS_DESKTOP_BOOT_LOG = $env:AGENT_LENS_DESKTOP_BOOT_LOG
  ELECTRON_ENABLE_LOGGING = $env:ELECTRON_ENABLE_LOGGING
}

$env:AGENT_LENS_PORT = [string]$port
$env:AGENT_LENS_DB_PATH = Join-Path $smokeRoot 'agent-lens.db'
$env:AGENT_LENS_VAULT_PATH = Join-Path $smokeRoot 'vault'
$env:AGENT_LENS_ENABLED_SOURCES = 'none'
$env:AGENT_LENS_DESKTOP_BOOT_LOG = $desktopBootLog
$env:ELECTRON_ENABLE_LOGGING = '1'

$process = $null
try {
  Write-Host "[AgentLens] 按双击等价方式启动打包客户端：$resolved"
  $process = Start-Process -FilePath $resolved -PassThru -RedirectStandardOutput $desktopStdout -RedirectStandardError $desktopStderr
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
catch {
  Write-DesktopDiagnostics
  throw
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
