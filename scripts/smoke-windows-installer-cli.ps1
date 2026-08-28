param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [bool]$RequireSignature = $false
)

$ErrorActionPreference = 'Stop'

function Normalize-PathEntry([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return $Value.Trim().Trim('"').TrimEnd('\\')
}

function User-PathEntries {
  $value = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ([string]::IsNullOrWhiteSpace($value)) { return @() }
  return @(
    $value -split ';' |
      ForEach-Object { Normalize-PathEntry $_ } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
}

function Find-EntryIndex([string[]]$Entries, [string]$Target) {
  $normalized = Normalize-PathEntry $Target
  for ($i = 0; $i -lt $Entries.Count; $i++) {
    if ((Normalize-PathEntry $Entries[$i]) -ieq $normalized) { return $i }
  }
  return -1
}

function Assert-DesktopCli([string]$InstallDir, [string]$OriginalProcessPath) {
  $installedCli = Join-Path $InstallDir 'agent-lens.cmd'
  if (-not (Test-Path $installedCli)) { throw "没有找到 Desktop CLI：$installedCli" }

  $env:Path = "$InstallDir;$OriginalProcessPath"
  $resolvedCli = Get-Command agent-lens -ErrorAction Stop
  if ((Normalize-PathEntry $resolvedCli.Source) -ine (Normalize-PathEntry $installedCli)) {
    throw "agent-lens 没有解析到 Desktop CLI：$($resolvedCli.Source)"
  }
  $cliHelp = (& agent-lens -h 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "Desktop CLI 执行 agent-lens -h 失败：$LASTEXITCODE`n$cliHelp" }
  if ($cliHelp -notmatch 'AgentLens|agent-lens|用法|Usage') { throw "Desktop CLI 帮助输出异常：$cliHelp" }
}

$installer = Get-Item $InstallerPath
$installDir = Join-Path $env:RUNNER_TEMP 'agent-lens-installed-smoke'
$fakeNpmPrefix = Join-Path $env:RUNNER_TEMP 'agent-lens-fake-npm-prefix'
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$originalProcessPath = $env:Path
$preserveMarker = $null

try {
  Remove-Item -Recurse -Force $installDir -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $fakeNpmPrefix -ErrorAction SilentlyContinue

  # 1. 没有有效 1.x npm AgentLens 时，Desktop 自己提供 agent-lens。
  $install = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw "Windows 安装器静默安装失败：$($install.ExitCode)" }

  $installedExe = Join-Path $installDir 'AgentLens.exe'
  if (-not (Test-Path $installedExe)) { throw "安装完成后没有找到 AgentLens.exe：$installedExe" }
  if ($RequireSignature) {
    $installedSignature = Get-AuthenticodeSignature $installedExe
    if ($installedSignature.Status -ne 'Valid') { throw "安装后的 AgentLens.exe 签名无效：$($installedSignature.Status)" }
  }

  $desktopIndex = Find-EntryIndex (User-PathEntries) $installDir
  if ($desktopIndex -lt 0) { throw "Desktop 安装后当前用户 PATH 未包含安装目录：$installDir" }
  Assert-DesktopCli $installDir $originalProcessPath
  ./scripts/smoke-windows-desktop.ps1 -ExecutablePath $installedExe

  # 模拟真实用户数据。覆盖升级和普通卸载默认都必须保留它。
  $dataDir = Join-Path $HOME '.agent-lens/1.0'
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $preserveMarker = Join-Path $dataDir 'windows-installer-preserve-ci.txt'
  'preserve-me' | Set-Content -Encoding UTF8 $preserveMarker

  # 2. 模拟用户随后安装有效的 1.x npm AgentLens。
  New-Item -ItemType Directory -Force -Path (Join-Path $fakeNpmPrefix 'node_modules\@z7ping\agent-lens') | Out-Null
  @"
{"name":"@z7ping/agent-lens","version":"1.0.0-alpha.2"}
"@ | Set-Content -Encoding UTF8 (Join-Path $fakeNpmPrefix 'node_modules\@z7ping\agent-lens\package.json')
  @"
@echo off
if "%1"=="prefix" if "%2"=="-g" (
  echo $fakeNpmPrefix
  exit /b 0
)
exit /b 1
"@ | Set-Content -Encoding ASCII (Join-Path $fakeNpmPrefix 'npm.cmd')
  @"
@echo off
echo npm-agent-lens-ci
exit /b 0
"@ | Set-Content -Encoding ASCII (Join-Path $fakeNpmPrefix 'agent-lens.cmd')

  $userPathWithFakeNpm = [Environment]::GetEnvironmentVariable('Path', 'User')
  [Environment]::SetEnvironmentVariable('Path', "$fakeNpmPrefix;$userPathWithFakeNpm", 'User')
  $env:Path = "$fakeNpmPrefix;$originalProcessPath"

  # Desktop 启动时会执行同一 helper 做自愈；这里直接调用它验证 npm 后装场景。
  $installedHelper = Join-Path $installDir 'agent-lens-cli-path.ps1'
  if (-not (Test-Path $installedHelper)) { throw "安装后缺少 CLI PATH helper：$installedHelper" }
  & $installedHelper -Action install -InstallDir $installDir

  $entriesAfterNpm = User-PathEntries
  $npmIndex = Find-EntryIndex $entriesAfterNpm $fakeNpmPrefix
  $desktopIndex = Find-EntryIndex $entriesAfterNpm $installDir
  if ($npmIndex -lt 0 -or $desktopIndex -lt 0 -or $npmIndex -ge $desktopIndex) {
    throw "有效 1.x npm 存在时 PATH 顺序错误：npm=$npmIndex desktop=$desktopIndex"
  }

  $env:Path = "$fakeNpmPrefix;$installDir;$originalProcessPath"
  $resolvedNpmCli = Get-Command agent-lens -ErrorAction Stop
  if ((Normalize-PathEntry $resolvedNpmCli.Source) -ine (Normalize-PathEntry (Join-Path $fakeNpmPrefix 'agent-lens.cmd'))) {
    throw "有效 1.x npm 存在时 agent-lens 未优先解析到 npm：$($resolvedNpmCli.Source)"
  }
  $npmOutput = (& agent-lens -h 2>&1 | Out-String)
  if ($npmOutput -notmatch 'npm-agent-lens-ci') { throw "npm CLI 优先级验证失败：$npmOutput" }

  # 3. 在 npm 仍存在时覆盖升级，必须继续保持 npm 优先且保留本地数据。
  $upgrade = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
  if ($upgrade.ExitCode -ne 0) { throw "Windows 安装器不能直接覆盖已有安装：$($upgrade.ExitCode)" }
  if (-not (Test-Path $installedExe)) { throw '覆盖升级后 AgentLens.exe 丢失' }
  if (-not (Test-Path (Join-Path $installDir 'agent-lens.cmd'))) { throw '覆盖升级后 agent-lens.cmd 丢失' }
  if (-not (Test-Path $preserveMarker)) { throw '覆盖升级错误删除了 ~/.agent-lens/1.0 数据' }

  $entriesAfterUpgrade = User-PathEntries
  $npmIndex = Find-EntryIndex $entriesAfterUpgrade $fakeNpmPrefix
  $desktopIndex = Find-EntryIndex $entriesAfterUpgrade $installDir
  if ($npmIndex -lt 0 -or $desktopIndex -lt 0 -or $npmIndex -ge $desktopIndex) {
    throw "覆盖升级后 npm/Desktop PATH 优先级被破坏：npm=$npmIndex desktop=$desktopIndex"
  }
  ./scripts/smoke-windows-desktop.ps1 -ExecutablePath $installedExe

  # 4. 模拟 npm AgentLens 被卸载：不需要重装 Desktop，PATH 中后置的 Desktop CLI 自动接替。
  Remove-Item -Force (Join-Path $fakeNpmPrefix 'agent-lens.cmd')
  Remove-Item -Recurse -Force (Join-Path $fakeNpmPrefix 'node_modules\@z7ping\agent-lens')
  $env:Path = "$fakeNpmPrefix;$installDir;$originalProcessPath"
  $resolvedFallback = Get-Command agent-lens -ErrorAction Stop
  if ((Normalize-PathEntry $resolvedFallback.Source) -ine (Normalize-PathEntry (Join-Path $installDir 'agent-lens.cmd'))) {
    throw "npm 卸载后 Desktop CLI 没有自动兜底：$($resolvedFallback.Source)"
  }
  $fallbackHelp = (& agent-lens -h 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $fallbackHelp -notmatch 'AgentLens|agent-lens|用法|Usage') {
    throw "npm 卸载后的 Desktop CLI 兜底失败：$fallbackHelp"
  }

  # 恢复假的 npm 文件，验证卸载 Desktop 绝不会动 npm 自己的目录或 PATH。
  New-Item -ItemType Directory -Force -Path (Join-Path $fakeNpmPrefix 'node_modules\@z7ping\agent-lens') | Out-Null
  '{"name":"@z7ping/agent-lens","version":"1.0.0-alpha.2"}' | Set-Content -Encoding UTF8 (Join-Path $fakeNpmPrefix 'node_modules\@z7ping\agent-lens\package.json')
  '@echo off`r`necho npm-agent-lens-ci`r`nexit /b 0' | Set-Content -Encoding ASCII (Join-Path $fakeNpmPrefix 'agent-lens.cmd')

  $uninstaller = Get-ChildItem $installDir -Filter 'Uninstall*.exe' | Select-Object -First 1
  if ($null -eq $uninstaller) { throw '覆盖升级后没有找到卸载器' }
  $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Windows 静默卸载失败：$($uninstall.ExitCode)" }
  if (-not (Test-Path $preserveMarker)) { throw '普通卸载错误删除了 ~/.agent-lens/1.0 数据' }

  $entriesAfterUninstall = User-PathEntries
  if ((Find-EntryIndex $entriesAfterUninstall $installDir) -ge 0) {
    throw "卸载后仍残留 Desktop PATH：$installDir"
  }
  if ((Find-EntryIndex $entriesAfterUninstall $fakeNpmPrefix) -lt 0) {
    throw '卸载 Desktop 错误删除了 npm PATH'
  }
  if (-not (Test-Path (Join-Path $fakeNpmPrefix 'agent-lens.cmd'))) {
    throw '卸载 Desktop 错误删除了 npm CLI'
  }

  Write-Host 'Windows Desktop CLI/npm 共存、升级、回退和卸载 smoke 通过。'
} finally {
  [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
  $env:Path = $originalProcessPath
  Remove-Item -Recurse -Force $fakeNpmPrefix -ErrorAction SilentlyContinue
  if ($null -ne $preserveMarker) {
    Remove-Item -Force $preserveMarker -ErrorAction SilentlyContinue
  }
}
