param(
  [Parameter(Mandatory = $true)][string]$NodePath,
  [Parameter(Mandatory = $true)][string]$HookScript
)

$ErrorActionPreference = 'SilentlyContinue'

try {
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $NodePath
  $startInfo.Arguments = '"' + $HookScript.Replace('"', '\"') + '"'
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true

  # Do not redirect stdin/stdout here. The child inherits the Hook process handles,
  # so native JSON input and neutral Hook output keep their original byte path.
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $process.WaitForExit()
} catch {
  # AgentLens observability must never block the upstream Agent Hook flow.
}

exit 0
