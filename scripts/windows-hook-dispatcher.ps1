param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('agent-lens-hook-codex', 'agent-lens-hook-claude')]
  [string]$Target
)

$ErrorActionPreference = 'SilentlyContinue'
$diagnosticPath = [string]$env:AGENT_LENS_HOOK_DISPATCHER_LOG

function Write-Diagnostic([string]$Message) {
  if ([string]::IsNullOrWhiteSpace($diagnosticPath)) { return }
  try {
    $line = '{0:o} pid={1} target={2} {3}' -f [DateTime]::UtcNow, $PID, $Target, $Message
    [System.IO.File]::AppendAllText(
      $diagnosticPath,
      $line + [Environment]::NewLine,
      (New-Object System.Text.UTF8Encoding($false))
    )
  } catch {
    # Diagnostics must never affect the passive Hook path.
  }
}

function Get-ValidInstallation([string]$Kind) {
  $installationsDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'installations'
  $recordPath = Join-Path $installationsDir ($Kind + '.json')
  if (-not (Test-Path -LiteralPath $recordPath)) {
    Write-Diagnostic ('provider ' + $Kind + ' invalid: record missing ' + $recordPath)
    return $null
  }

  try {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    if ($null -eq $record) {
      Write-Diagnostic ('provider ' + $Kind + ' invalid: empty record')
      return $null
    }
    if ([string]$record.kind -ne $Kind) {
      Write-Diagnostic ('provider ' + $Kind + ' invalid: kind mismatch')
      return $null
    }
    if (-not (Test-Path -LiteralPath ([string]$record.executable))) {
      Write-Diagnostic ('provider ' + $Kind + ' invalid: executable missing ' + [string]$record.executable)
      return $null
    }
    if (-not (Test-Path -LiteralPath ([string]$record.hookRoot))) {
      Write-Diagnostic ('provider ' + $Kind + ' invalid: hook root missing ' + [string]$record.hookRoot)
      return $null
    }

    $hookName = if ($Target -eq 'agent-lens-hook-codex') {
      'agent-lens-hook-codex.mjs'
    } else {
      'agent-lens-hook-claude.mjs'
    }
    $hookScript = Join-Path ([string]$record.hookRoot) $hookName
    if (-not (Test-Path -LiteralPath $hookScript)) {
      Write-Diagnostic ('provider ' + $Kind + ' invalid: hook missing ' + $hookScript)
      return $null
    }

    Write-Diagnostic ('provider ' + $Kind + ' valid executable=' + [string]$record.executable + ' hook=' + $hookScript)
    return [pscustomobject]@{
      kind = $Kind
      executable = [string]$record.executable
      hookScript = $hookScript
      electronRunAsNode = ($record.electronRunAsNode -eq $true)
    }
  } catch {
    Write-Diagnostic ('provider ' + $Kind + ' invalid: ' + $_.Exception.ToString())
    return $null
  }
}

try {
  Write-Diagnostic ('dispatcher start scriptRoot=' + $PSScriptRoot)

  # Desktop is self-contained and therefore preferred when both distributions exist.
  # A stale record is ignored immediately because every invocation validates real files.
  $installation = Get-ValidInstallation 'desktop'
  if ($null -eq $installation) { $installation = Get-ValidInstallation 'npm' }
  if ($null -eq $installation) {
    Write-Diagnostic 'no valid provider; neutral exit'
    exit 0
  }

  Write-Diagnostic ('selected provider=' + $installation.kind)

  # Consume the upstream JSON before starting the selected provider, then forward it
  # through a private stdin pipe. Write UTF-8 bytes directly to the redirected base
  # stream instead of assigning ProcessStartInfo.StandardInputEncoding: Windows
  # PowerShell 5.1 can run on .NET Framework variants where that property is absent.
  $rawInput = [Console]::In.ReadToEnd()
  Write-Diagnostic ('stdin chars=' + $rawInput.Length)

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $installation.executable
  $startInfo.Arguments = '"' + $installation.hookScript.Replace('"', '\"') + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  if ($installation.electronRunAsNode) {
    $startInfo.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
  }

  # stdout/stderr stay inherited and therefore keep the upstream Hook flow neutral.
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  Write-Diagnostic ('provider started pid=' + $process.Id)
  if ($rawInput.Length -gt 0) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($rawInput)
    $process.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
    $process.StandardInput.BaseStream.Flush()
    Write-Diagnostic ('stdin bytes written=' + $bytes.Length)
  }
  $process.StandardInput.Close()
  $process.WaitForExit()
  Write-Diagnostic ('provider exitCode=' + $process.ExitCode)
} catch {
  Write-Diagnostic ('dispatcher exception=' + $_.Exception.ToString())
  # Observability must never block the upstream Agent Hook flow.
}

exit 0
