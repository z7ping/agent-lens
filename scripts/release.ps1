param(
  [string]$Version,
  [ValidateSet('Auto', 'Patch', 'Minor', 'Major', 'Stable')]
  [string]$ReleaseType = 'Auto',
  [switch]$Preview,
  [switch]$Candidate,
  [switch]$Publish,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$Repo = 'z7ping/agent-lens'

$modeCount = @($Preview.IsPresent, $Candidate.IsPresent, $Publish.IsPresent).Where({ $_ }).Count
if ($modeCount -gt 1) {
  throw '不能同时指定 -Preview、-Candidate 和 -Publish。'
}
if ($Version -and $PSBoundParameters.ContainsKey('ReleaseType')) {
  throw '不能同时指定 -Version 和 -ReleaseType。'
}
if ($Publish -and $PSBoundParameters.ContainsKey('ReleaseType')) {
  throw '-Publish 只晋升当前已准备版本，不能同时指定 -ReleaseType。'
}

function Assert-CleanWorktree {
  $status = @(git status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 工作区状态。' }
  if ($status.Count -gt 0) {
    throw '工作区不干净，请先提交或处理现有修改后再执行发版。'
  }
}

function Test-RemoteTag([string]$Tag) {
  $result = @(git ls-remote --tags origin "refs/tags/$Tag")
  if ($LASTEXITCODE -ne 0) { throw '无法检查远端 Tag，请确认网络和 Git 凭据。' }
  return $result.Count -gt 0
}

function Get-RemoteTagCommit([string]$Tag) {
  $peeled = @(git ls-remote --tags origin "refs/tags/$Tag^{}")
  if ($LASTEXITCODE -ne 0) { throw "无法解析远端 Tag：$Tag" }
  $line = if ($peeled.Count -gt 0) { $peeled[0] } else { @(git ls-remote --tags origin "refs/tags/$Tag")[0] }
  if (-not $line) { return $null }
  return ($line -split '\s+')[0]
}

function Assert-GhReady {
  gh auth status | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI 尚未登录，请先执行 gh auth login。' }
}

$currentVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version

if ($Publish) {
  Assert-CleanWorktree
  Assert-GhReady

  if ($Version) {
    $resolved = (& node scripts/resolve-release-version.mjs $currentVersion explicit $Version)
    if ($LASTEXITCODE -ne 0 -or -not $resolved) { throw '无法校验待发布版本。' }
    if ($resolved -ne $currentVersion) {
      throw "-Publish 只能晋升当前 package.json 版本 $currentVersion，实际请求 $resolved"
    }
  } else {
    $Version = $currentVersion
  }

  $tag = "v$Version"
  node scripts/check-version-consistency.mjs
  if ($LASTEXITCODE -ne 0) { throw '版本一致性检查失败。' }

  if (-not (Test-RemoteTag $tag)) { throw "远端 Tag 不存在：$tag" }
  $remoteCommit = Get-RemoteTagCommit $tag
  $headCommit = git rev-parse HEAD
  if ($remoteCommit -ne $headCommit) {
    throw "当前 HEAD $headCommit 与远端候选 Tag $tag -> $remoteCommit 不一致，请切回候选提交再发布。"
  }

  node scripts/check-release-assets.mjs $tag
  if ($LASTEXITCODE -ne 0) { throw '候选产物尚未全部就绪，禁止 Publish。' }

  $releaseArgs = @('release', 'edit', $tag, '--repo', $Repo, '--draft=false')
  if (-not $Version.Contains('-')) { $releaseArgs += '--latest' }
  gh @releaseArgs
  if ($LASTEXITCODE -ne 0) { throw "无法晋升 GitHub Release：$tag" }

  Write-Host "Release 已晋升：$tag"
  Write-Host '桌面产物不会重新构建；npm 工作流将下载并发布 Draft 阶段已经验证过的 tgz。'
  exit 0
}

Assert-CleanWorktree

$reusePreparedVersion = $false
if ($Version) {
  $Version = (& node scripts/resolve-release-version.mjs $currentVersion explicit $Version)
} elseif ($Candidate -and -not (Test-RemoteTag "v$currentVersion")) {
  # 当前版本尚未有远端 Tag，视为已经完成版本准备，可直接进入候选阶段。
  $Version = $currentVersion
  $reusePreparedVersion = $true
  Write-Host "检测到已准备但尚未打 Tag 的版本：$Version"
} else {
  $Version = (& node scripts/resolve-release-version.mjs $currentVersion $ReleaseType.ToLowerInvariant())
  Write-Host "自动计算版本：$currentVersion -> $Version（$ReleaseType）"
}
if ($LASTEXITCODE -ne 0 -or -not $Version) {
  throw '无法计算目标版本。'
}
$tag = "v$Version"

if ($Preview) {
  if ($reusePreparedVersion) {
    Write-Host "当前版本已经准备：$tag"
  } else {
    node scripts/bump-version.mjs $Version --dry-run
    if ($LASTEXITCODE -ne 0) { throw '版本预览失败。' }
  }
  Write-Host "预览完成，未修改文件：$tag"
  exit 0
}

if (-not $reusePreparedVersion -and $Version -ne $currentVersion) {
  node scripts/bump-version.mjs $Version
  if ($LASTEXITCODE -ne 0) { throw '版本同步失败。' }

  if (-not $SkipChecks) {
    npm run release:check
    if ($LASTEXITCODE -ne 0) { throw '发行检查失败。' }
  }
  git diff --check
  if ($LASTEXITCODE -ne 0) { throw 'git diff --check 失败。' }

  $pending = @(git status --porcelain)
  if ($pending.Count -gt 0) {
    git add package.json package-lock.json apps packages CHANGELOG.md
    git commit -m "发布准备 AgentLens $Version"
    if ($LASTEXITCODE -ne 0) { throw '无法提交版本准备修改。' }
  }
} elseif (-not $SkipChecks) {
  npm run release:check
  if ($LASTEXITCODE -ne 0) { throw '发行检查失败。' }
}

if (-not $Candidate) {
  Write-Host "版本准备完成：$tag"
  Write-Host '下一步：完善并提交 CHANGELOG 当前版本内容，然后执行：'
  Write-Host "  pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version $Version -Candidate"
  exit 0
}

Assert-CleanWorktree
Assert-GhReady

$previousTag = $null
$releaseListJson = gh release list --repo $Repo --limit 1 --json tagName
if ($LASTEXITCODE -eq 0 -and $releaseListJson) {
  $releaseList = $releaseListJson | ConvertFrom-Json
  if ($releaseList.Count -gt 0) { $previousTag = $releaseList[0].tagName }
}

$notesPath = Join-Path $env:TEMP "agent-lens-$Version-release-notes.md"
$notesArgs = @('scripts/render-release-notes.mjs', '--version', $Version, '--output', $notesPath)
if ($previousTag -and $previousTag -ne $tag) {
  $notesArgs += @('--previous-tag', $previousTag)
}
node @notesArgs
if ($LASTEXITCODE -ne 0) {
  throw "Release Notes 未达到候选标准。版本已经准备为 $Version；请完善并提交 CHANGELOG 后重新执行 -Version $Version -Candidate。"
}

$headCommit = git rev-parse HEAD
$localTagExists = [bool](git rev-parse --verify "refs/tags/$tag" 2>$null)
if ($localTagExists) {
  $localTagCommit = git rev-list -n 1 $tag
  if ($localTagCommit -ne $headCommit) {
    throw "本地 Tag 已存在但不指向当前提交：$tag"
  }
} else {
  git tag -a $tag -m "AgentLens $tag"
  if ($LASTEXITCODE -ne 0) { throw "无法创建 Tag：$tag" }
}

$remoteTagExists = Test-RemoteTag $tag
if ($remoteTagExists) {
  $remoteCommit = Get-RemoteTagCommit $tag
  if ($remoteCommit -ne $headCommit) {
    throw "远端 Tag $tag 已存在但指向 $remoteCommit，当前提交为 $headCommit"
  }
  Write-Host "复用已指向当前提交的远端 Tag：$tag"
} else {
  git push --atomic origin HEAD "refs/tags/$tag"
  if ($LASTEXITCODE -ne 0) { throw "无法推送候选提交和 Tag：$tag" }
}

$existingReleaseJson = gh release view $tag --repo $Repo --json tagName,isDraft,isPrerelease 2>$null
if ($LASTEXITCODE -eq 0 -and $existingReleaseJson) {
  $existingRelease = $existingReleaseJson | ConvertFrom-Json
  if (-not $existingRelease.isDraft) {
    throw "Release $tag 已经不是 Draft，不能作为候选重新准备。"
  }
  $editArgs = @('release', 'edit', $tag, '--repo', $Repo, '--title', "AgentLens $tag", '--notes-file', $notesPath)
  gh @editArgs
  if ($LASTEXITCODE -ne 0) { throw "无法更新 Draft Release：$tag" }
} else {
  $releaseArgs = @('release', 'create', $tag, '--repo', $Repo, '--draft', '--title', "AgentLens $tag", '--notes-file', $notesPath)
  if ($Version.Contains('-')) { $releaseArgs += '--prerelease' }
  gh @releaseArgs
  if ($LASTEXITCODE -ne 0) { throw "无法创建 Draft Release：$tag" }
}

Write-Host "Draft Release 候选已创建：$tag"
Write-Host 'Tag 推送会启动 Windows / macOS / Linux / npm 候选构建；所有产物齐全前不要 Publish。'
Write-Host '候选全部就绪后执行：'
Write-Host "  pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version $Version -Publish"
