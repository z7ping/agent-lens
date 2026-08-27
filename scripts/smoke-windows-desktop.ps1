param(
  [string]$ExecutablePath = 'release/windows/win-unpacked/AgentLens.exe'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

$resolved = (Resolve-Path $ExecutablePath).Path
$port = Get-Random -Minimum 57000 -Maximum 57999
$smokeTempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } elseif ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
$smokeRoot = Join-Path $smokeTempRoot ("agent-lens-desktop-smoke-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $smokeRoot | Out-Null
$desktopStdout = Join-Path $smokeRoot 'desktop.stdout.log'
$desktopStderr = Join-Path $smokeRoot 'desktop.stderr.log'
$smokeUserData = Join-Path $smokeRoot 'electron-user-data'
$installLogDir = Join-Path (Split-Path -Parent $resolved) 'logs'
$desktopBootLog = Join-Path $installLogDir 'desktop.log'
$daemonLog = Join-Path $installLogDir 'daemon.log'

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
    foreach ($corner in @(
      $bitmap.GetPixel(0, 0),
      $bitmap.GetPixel($bitmap.Width - 1, 0),
      $bitmap.GetPixel(0, $bitmap.Height - 1),
      $bitmap.GetPixel($bitmap.Width - 1, $bitmap.Height - 1)
    )) {
      if ($corner.A -ne 0) { throw 'AgentLens.exe 内嵌图标四角不是透明像素' }
    }

    $darkEdgeSamples = 0
    for ($x = 0; $x -lt $bitmap.Width; $x += 1) {
      for ($y = 0; $y -lt $bitmap.Height; $y += 1) {
        if ($x -ge 3 -and $y -ge 3 -and $x -lt $bitmap.Width - 3 -and $y -lt $bitmap.Height - 3) { continue }
        $pixel = $bitmap.GetPixel($x, $y)
        if ($pixel.A -gt 160 -and $pixel.R -lt 50 -and $pixel.G -lt 80 -and $pixel.B -lt 120) {
          $darkEdgeSamples += 1
        }
      }
    }
    if ($darkEdgeSamples -gt 0) {
      throw "AgentLens.exe 内嵌图标仍有深色外边缘：采样=$darkEdgeSamples"
    }
    Write-Host "[AgentLens] Windows EXE 图标检查通过：$($bitmap.Width)x$($bitmap.Height)，采样颜色=$($colors.Count)"
  }
  finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
    $icon.Dispose()
  }
}

function Write-DesktopDiagnostics {
  Write-Host '[AgentLens] 桌面启动失败，输出可用运行日志：'
  foreach ($candidate in @($desktopBootLog, $daemonLog, $desktopStdout, $desktopStderr)) {
    if (Test-Path -LiteralPath $candidate) {
      Write-Host "--- $candidate ---"
      Get-Content -LiteralPath $candidate -Tail 200 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
    }
  }
}

Assert-EmbeddedIconVisible $resolved

$previous = @{
  AGENT_LENS_PORT = $env:AGENT_LENS_PORT
  AGENT_LENS_DB_PATH = $env:AGENT_LENS_DB_PATH
  AGENT_LENS_VAULT_PATH = $env:AGENT_LENS_VAULT_PATH
  AGENT_LENS_ENABLED_SOURCES = $env:AGENT_LENS_ENABLED_SOURCES
  AGENT_LENS_DESKTOP_SMOKE = $env:AGENT_LENS_DESKTOP_SMOKE
  AGENT_LENS_DESKTOP_BOOT_LOG = $env:AGENT_LENS_DESKTOP_BOOT_LOG
  ELECTRON_ENABLE_LOGGING = $env:ELECTRON_ENABLE_LOGGING
}

$env:AGENT_LENS_PORT = [string]$port
$env:AGENT_LENS_DB_PATH = Join-Path $smokeRoot 'agent-lens.db'
$env:AGENT_LENS_VAULT_PATH = Join-Path $smokeRoot 'vault'
$env:AGENT_LENS_ENABLED_SOURCES = 'none'
$env:AGENT_LENS_DESKTOP_SMOKE = '1'
Remove-Item Env:AGENT_LENS_DESKTOP_BOOT_LOG -ErrorAction SilentlyContinue
$env:ELECTRON_ENABLE_LOGGING = '1'

$process = $null
try {
  Write-Host "[AgentLens] 按双击等价方式启动打包客户端：$resolved"
  $launchStartedAt = (Get-Date).AddSeconds(-1)
  $process = Start-Process -FilePath $resolved -ArgumentList "--user-data-dir=$smokeUserData" -PassThru -RedirectStandardOutput $desktopStdout -RedirectStandardError $desktopStderr
  $windowDeadline = (Get-Date).AddSeconds(15)
  while ((Get-Date) -lt $windowDeadline) {
    if ($process.HasExited) {
      throw "AgentLens.exe 在窗口可见前退出，退出码：$($process.ExitCode)"
    }
    $process.Refresh()
    if ($process.MainWindowHandle -ne 0) { break }
    Start-Sleep -Milliseconds 200
  }
  $process.Refresh()
  if ($process.MainWindowHandle -eq 0) {
    throw '打包后的 AgentLens.exe 在普通双击启动后 15 秒内没有创建可见窗口'
  }
  Write-Host "[AgentLens] Windows 启动窗口可见：handle=$($process.MainWindowHandle)"

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
  if (-not (Test-Path -LiteralPath $desktopBootLog)) {
    throw "打包客户端没有在安装目录写入 desktop.log：$desktopBootLog"
  }
  if ((Get-Item -LiteralPath $desktopBootLog).LastWriteTime -lt $launchStartedAt) {
    throw "打包客户端没有更新安装目录中的 desktop.log：$desktopBootLog"
  }
  if (-not (Test-Path -LiteralPath $daemonLog)) {
    throw "打包客户端没有在安装目录写入 daemon.log：$daemonLog"
  }
  if ((Get-Item -LiteralPath $daemonLog).LastWriteTime -lt $launchStartedAt) {
    throw "打包客户端没有更新安装目录中的 daemon.log：$daemonLog"
  }

  Write-Host "[AgentLens] Windows 打包客户端启动冒烟通过：pid=$($process.Id), port=$port, logs=$installLogDir"
}
catch {
  Write-DesktopDiagnostics
  throw
}
finally {
  if ($null -ne $process -and -not $process.HasExited) {
    & taskkill.exe /PID $process.Id /T /F 2>$null | Out-Null
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
