param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'uninstall')]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$InstallDir
)

$ErrorActionPreference = 'Stop'

function Normalize-PathEntry([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return $Value.Trim().Trim('"').TrimEnd('\\')
}

function Find-NpmAgentLens {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($null -eq $npmCommand) {
    $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  }
  if ($null -eq $npmCommand) { return $null }

  try {
    $prefix = (& $npmCommand.Source prefix -g 2>$null | Select-Object -First 1)
    $prefix = Normalize-PathEntry ([string]$prefix)
    if ([string]::IsNullOrWhiteSpace($prefix)) { return $null }

    $packageJson = Join-Path $prefix 'node_modules\@z7ping\agent-lens\package.json'
    $cli = Join-Path $prefix 'agent-lens.cmd'
    if (-not (Test-Path $packageJson -PathType Leaf) -or -not (Test-Path $cli -PathType Leaf)) {
      return $null
    }

    $package = Get-Content -Raw -Encoding UTF8 $packageJson | ConvertFrom-Json
    if ([string]$package.name -cne '@z7ping/agent-lens') { return $null }
    $version = [string]$package.version
    if ($version -notmatch '^(\d+)\.') { return $null }
    if ([int]$Matches[1] -lt 1) { return $null }

    return [pscustomobject]@{
      Prefix = $prefix
      Cli = $cli
      Version = $version
    }
  } catch {
    return $null
  }
}

function Insert-After([string[]]$Entries, [string]$Anchor, [string]$Value) {
  for ($i = 0; $i -lt $Entries.Count; $i++) {
    if ((Normalize-PathEntry $Entries[$i]) -ieq $Anchor) {
      $before = @()
      if ($i -ge 0) { $before = @($Entries[0..$i]) }
      $after = @()
      if ($i + 1 -lt $Entries.Count) { $after = @($Entries[($i + 1)..($Entries.Count - 1)]) }
      return @($before + $Value + $after)
    }
  }
  return @($Entries + $Value)
}

$target = Normalize-PathEntry $InstallDir
if ([string]::IsNullOrWhiteSpace($target)) {
  throw 'InstallDir is empty'
}

$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) {
  throw 'Cannot open HKCU\Environment for write'
}

$mode = 'uninstall'
$npmAgentLens = $null
try {
  $rawPath = [string]$key.GetValue(
    'Path',
    '',
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  )

  $entries = @()
  if (-not [string]::IsNullOrWhiteSpace($rawPath)) {
    $entries = @(
      $rawPath -split ';' |
        ForEach-Object { $_.Trim() } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    )
  }

  $filtered = @(
    $entries | Where-Object {
      (Normalize-PathEntry $_) -ine $target
    }
  )

  if ($Action -eq 'install') {
    $npmAgentLens = Find-NpmAgentLens
    $desktopEntry = $InstallDir.TrimEnd('\\')
    if ($null -ne $npmAgentLens) {
      # 有有效 1.x npm 发行时，npm CLI 是主入口；Desktop CLI 仍留在 PATH 后方作为卸载 npm 后的兜底。
      $filtered = Insert-After $filtered $npmAgentLens.Prefix $desktopEntry
      $mode = 'npm-primary'
    } else {
      # 没有有效 1.x npm（包括仅残留 0.x）时，Desktop 必须成为确定性的 agent-lens 命令入口。
      $filtered = @($desktopEntry) + $filtered
      $mode = 'desktop-primary'
    }
  }

  $nextPath = $filtered -join ';'
  if ($nextPath -cne $rawPath) {
    $key.SetValue('Path', $nextPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
} finally {
  $key.Close()
}

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class AgentLensEnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        IntPtr wParam,
        string lParam,
        uint fuFlags,
        uint uTimeout,
        out IntPtr lpdwResult);
}
'@

$result = [IntPtr]::Zero
[AgentLensEnvironmentBroadcast]::SendMessageTimeout(
  [IntPtr]0xffff,
  0x001A,
  [IntPtr]::Zero,
  'Environment',
  0x0002,
  5000,
  [ref]$result
) | Out-Null

if ($null -ne $npmAgentLens) {
  Write-Host "AgentLens Desktop CLI PATH $Action complete: mode=$mode npm=$($npmAgentLens.Version) prefix=$($npmAgentLens.Prefix) desktop=$InstallDir"
} else {
  Write-Host "AgentLens Desktop CLI PATH $Action complete: mode=$mode desktop=$InstallDir"
}
