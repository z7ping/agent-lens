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

$target = Normalize-PathEntry $InstallDir
if ([string]::IsNullOrWhiteSpace($target)) {
  throw 'InstallDir is empty'
}

$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($null -eq $key) {
  throw 'Cannot open HKCU\Environment for write'
}

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
    $filtered += $InstallDir.TrimEnd('\\')
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

Write-Host "AgentLens Desktop CLI PATH $Action complete: $InstallDir"
