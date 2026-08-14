param(
  [string]$SourcePath,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
  throw "windows-hook-runner.exe can only be built on Windows."
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $SourcePath) {
  $SourcePath = Join-Path $ScriptDir "windows-hook-runner.cs"
}
if (-not $OutputPath) {
  $OutputPath = Join-Path $ScriptDir "windows-hook-runner.exe"
}

if (-not (Test-Path -LiteralPath $SourcePath)) {
  throw "Missing source file: $SourcePath"
}

$candidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)

$csc = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) {
  throw "Could not find .NET Framework csc.exe. Install .NET Framework build tools or use the npm package release."
}

$OutputDir = Split-Path -Parent $OutputPath
if ($OutputDir) {
  New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
}

& $csc /nologo /target:winexe /platform:x64 /optimize+ /out:$OutputPath $SourcePath
if ($LASTEXITCODE -ne 0) {
  throw "csc.exe failed with exit code $LASTEXITCODE"
}

$bytes = [System.IO.File]::ReadAllBytes($OutputPath)
if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
  throw "Built file is not a valid PE executable: $OutputPath"
}

$peOffset = [BitConverter]::ToInt32($bytes, 0x3c)
$subsystem = [BitConverter]::ToUInt16($bytes, $peOffset + 24 + 68)
if ($subsystem -ne 2) {
  throw "windows-hook-runner.exe must use the Windows GUI subsystem; got $subsystem"
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([System.IO.File]::ReadAllBytes($OutputPath))
} finally {
  $sha256.Dispose()
}
$hash = -join ($hashBytes | ForEach-Object { $_.ToString("X2") })
Write-Host "Built $OutputPath"
Write-Host "SHA256 $hash"
