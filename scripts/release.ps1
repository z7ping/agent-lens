param(
  [string]$Version,
  [ValidateSet('Auto', 'Patch', 'Minor', 'Major', 'Stable')]
  [string]$ReleaseType = 'Auto',
  [switch]$Preview,
  [switch]$Publish,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
if ($Preview -and $Publish) {
  throw '不能同时指定 -Preview 和 -Publish。'
}
if ($Version -and $PSBoundParameters.ContainsKey('ReleaseType')) {
  throw '不能同时指定 -Version 和 -ReleaseType。'
}

$currentVersion = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
$preparedCurrentTag = "v$currentVersion"
$reusePreparedVersion = $false
if (-not $Version -and $Publish -and (git rev-parse --verify "refs/tags/$preparedCurrentTag" 2>$null)) {
  $preparedTagCommit = git rev-list -n 1 $preparedCurrentTag
  $headCommit = git rev-parse HEAD
  $reusePreparedVersion = $preparedTagCommit -eq $headCommit
}
if ($reusePreparedVersion) {
  $Version = $currentVersion
  Write-Host "检测到已准备版本，将直接发布：$Version"
} elseif ($Version) {
  $Version = (& node scripts/resolve-release-version.mjs $currentVersion explicit $Version)
} else {
  $Version = (& node scripts/resolve-release-version.mjs $currentVersion $ReleaseType.ToLowerInvariant())
  Write-Host "自动计算版本：$currentVersion -> $Version（$ReleaseType）"
}
if ($LASTEXITCODE -ne 0 -or -not $Version) {
  throw '无法计算目标版本。'
}
$tag = "v$Version"

$status = @(git status --porcelain)
if ($status.Count -gt 0) {
  throw '工作区不干净，请先提交或处理现有修改后再执行发版。'
}
if ($Preview) {
  node scripts/bump-version.mjs $Version --dry-run
  Write-Host "预览完成，未修改文件：$tag"
  exit 0
}
$tagExists = [bool](git rev-parse --verify "refs/tags/$tag" 2>$null)
if ($tagExists) {
  $tagCommit = git rev-list -n 1 $tag
  $headCommit = git rev-parse HEAD
  if ($tagCommit -ne $headCommit) {
    throw "本地 Tag 已存在但不指向当前提交：$tag"
  }
  Write-Host "复用已准备且指向当前提交的本地 Tag：$tag"
}

node scripts/bump-version.mjs $Version
if (-not $SkipChecks) { npm run release:check }
git diff --check
$pending = @(git status --porcelain)
if ($pending.Count -gt 0) {
  git add .github/workflows/npm-publish.yml package.json package-lock.json apps packages scripts CHANGELOG.md docs/1.0/RELEASE-RUNBOOK.md
  git commit -m "发布 AgentLens $Version"
}
if (-not $tagExists) {
  git tag -a $tag -m "AgentLens $Version"
}

if (-not $Publish) {
  Write-Host "本地发版准备完成：$tag"
  Write-Host "检查无误后执行：pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version $Version -Publish"
  exit 0
}

$remoteTag = @(git ls-remote --tags origin "refs/tags/$tag")
if ($LASTEXITCODE -ne 0) {
  throw '无法检查远端 Tag，请确认网络和 Git 凭据。'
}
if ($remoteTag.Count -gt 0) {
  throw "远端 Tag 已存在，已停止发布：$tag"
}
git push --atomic origin HEAD "refs/tags/$tag"
$releaseArgs = @('release', 'create', $tag, '--title', "AgentLens $tag", '--generate-notes')
if ($Version -match '-') { $releaseArgs += '--prerelease' }
gh @releaseArgs
