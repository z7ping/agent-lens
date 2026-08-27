param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [switch]$Publish,
  [switch]$SkipChecks
)

$ErrorActionPreference = 'Stop'
$tag = "v$Version"
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "版本号不是合法 SemVer：$Version"
}

$status = @(git status --porcelain)
if ($status.Count -gt 0) {
  throw '工作区不干净，请先提交或处理现有修改后再执行发版。'
}
if (git rev-parse --verify "refs/tags/$tag" 2>$null) {
  throw "本地 Tag 已存在：$tag"
}

node scripts/bump-version.mjs $Version
if (-not $SkipChecks) { npm run release:check }
git diff --check
$pending = @(git status --porcelain)
if ($pending.Count -gt 0) {
  git add .github/workflows/npm-publish.yml package.json package-lock.json apps packages scripts CHANGELOG.md docs/1.0/RELEASE-RUNBOOK.md
  git commit -m "发布 AgentLens $Version"
}
git tag -a $tag -m "AgentLens $Version"

if (-not $Publish) {
  Write-Host "本地发版准备完成：$tag"
  Write-Host "检查无误后执行：pwsh -File .\scripts\release.ps1 -Version $Version -Publish"
  exit 0
}

git push origin HEAD
git push origin $tag
$releaseArgs = @('release', 'create', $tag, '--title', "AgentLens $tag", '--generate-notes')
if ($Version -match '-') { $releaseArgs += '--prerelease' }
gh @releaseArgs
