param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('agent-lens-hook-codex', 'agent-lens-hook-claude')]
  [string]$Target
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-ValidInstallation([string]$Kind) {
  $installationsDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'installations'
  $recordPath = Join-Path $installationsDir ($Kind + '.json')
  if (-not (Test-Path -LiteralPath $recordPath)) { return $null }

  try {
    $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    if ($null -eq $record) { return $null }
    if ([string]$record.kind -ne $Kind) { return $null }
    if (-not (Test-Path -LiteralPath ([string]$record.executable))) { return $null }
    if (-not (Test-Path -LiteralPath ([string]$record.hookRoot))) { return $null }

    $hookName = if ($Target -eq 'agent-lens-hook-codex') {
      'agent-lens-hook-codex.mjs'
    } else {
      'agent-lens-hook-claude.mjs'
    }
    $hookScript = Join-Path ([string]$record.hookRoot) $hookName
    if (-not (Test-Path -LiteralPath $hookScript)) { return $null }

    return [pscustomobject]@{
      executable = [string]$record.executable
      hookScript = $hookScript
      electronRunAsNode = ($record.electronRunAsNode -eq $true)
    }
  } catch {
    return $null
  }
}

try {
  # Desktop is self-contained and therefore preferred when both distributions exist.
  # A stale record is ignored immediately because every invocation validates real files.
  $installation = Get-ValidInstallation 'desktop'
  if ($null -eq $installation) { $installation = Get-ValidInstallation 'npm' }
  if ($null -eq $installation) { exit 0 }

  # PowerShell cannot safely let a child Hook inherit the same piped stdin handle while
  # the parent synchronously waits for that child: EOF ownership becomes ambiguous and
  # Node's `for await (process.stdin)` can wait forever. Consume the native Hook JSON
  # first, then give the selected provider its own redirected stdin and close it
  # explicitly so the child always observes EOF.
  $rawInput = [Console]::In.ReadToEnd()

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
  # stdin is explicitly forwarded as text because supported native Hooks provide JSON.
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.StandardInput.Write($rawInput)
  $process.StandardInput.Close()
  $process.WaitForExit()
} catch {
  # Observability must never block the upstream Agent Hook flow.
}

exit 0
