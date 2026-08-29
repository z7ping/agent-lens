# AgentLens 1.0 发版流程

## 1. 前置条件

- 工作区必须干净；不要把私密仓库文件带入公开仓库。
- 已安装 Node.js 22、GitHub CLI，并完成 `gh auth status` 登录。
- 当前仓库的 GitHub Actions Secrets 已配置：预发布可以不配置签名凭据；正式版需要 Windows 和 macOS 签名/公证凭据。
- 版本号使用 SemVer，例如 `1.0.0-alpha.1`、`1.0.0-beta.1`、`1.0.0`。

## 2. 日常一键发布

日常发布只执行：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Publish
```

该命令自动计算下一个版本、同步所有版本文件、更新 CHANGELOG、运行完整发行检查、创建提交和 Tag、原子推送，并创建 GitHub Release。日常发布不需要手工填写版本号，也不需要先执行预览或准备命令。

默认的 `Auto` 规则是：

- 当前为预发布版时递增末尾序号，例如 `1.0.0-alpha.1 -> 1.0.0-alpha.2`；
- 当前为正式版时递增 patch，例如 `1.0.0 -> 1.0.1`。

如果只想确认自动计算结果而不修改任何文件，可以执行可选预览：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Preview
```

需要结束预发布或明确升 minor / major 时，才直接使用高级入口：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -ReleaseType Stable -Publish
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -ReleaseType Minor -Publish
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -ReleaseType Major -Publish
```

高级场景仍可用 `-Version 1.0.0-beta.1 -Publish` 显式指定版本；脚本会拒绝降级和非法 SemVer。

## 3. 可选：只在本地准备

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1
```

默认会执行完整 `release:check`，然后创建：

- 提交：`发布 AgentLens <自动计算出的版本>`
- Tag：`v<自动计算出的版本>`

该模式不会推送远端，适合先检查提交和 Tag。

## 4. 发布已经在一键命令中完成

如果第 3 节选择了只在本地准备，确认后执行：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Publish
```

脚本会自动计算并同步版本，完成检查和提交，然后以原子推送同时上传当前提交与 Tag，并创建 GitHub Release。带 `alpha` / `beta` / `rc` 的版本自动标记为 Pre-release；GitHub Release 发布后，Windows、macOS/Linux 和 npm 工作流会自动运行。

如果先执行了第 3 节的本地准备，脚本会打印带确定版本号的发布命令。再次执行该命令时，只会复用“指向当前提交”的本地 Tag；同名 Tag 指向其他提交或远端已经存在时会停止发布。

## 5. 发布后核对

```powershell
$version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
gh run list --repo z7ping/agent-lens --limit 10
gh release view "v$version" --repo z7ping/agent-lens
npm view @z7ping/agent-lens versions --json
```

预发布版本发布到 npm 的 `alpha` / `beta` / `rc` dist-tag；稳定版发布到 `latest`。不要重复使用已经存在的版本号或 Tag。

## 6. 常见失败

- `Release tag ... does not match package version ...`：Tag、根 `package.json` 和锁文件版本没有同步，重新运行版本同步命令。
- `git@github.com: Permission denied` 且路径包含 `release/*.tgz`：必须使用工作流中的 `./release/...tgz` 文件路径，不能让 npm 将它当作 Git 依赖解析。
- Windows/macOS 正式版签名门禁失败：配置对应的 Actions Secrets；Alpha/Beta/RC 可以生成未签名狗粮包。
- Release 页面已有同名 Tag：不要删除历史 Release，升级 patch 或 prerelease 序号后重新发版。

## 发布修复分支与升级回归

- 发布修复建议从目标稳定基线切出 `release/<version>`；该分支只接收本次发版修复，不混入下一阶段功能开发。
- 预发布也必须验证上一已发布版本到当前候选版本的真实升级路径，不能只验证同一安装包覆盖自己。
- Windows Desktop 升级至少检查：`~/.agent-lens/1.0` 数据保留、Daemon/`status`/`doctor` 正常、Hooks 仍有效、登录自启不丢失、正式 Web 可读取旧数据。
- npm / CLI 升级至少检查 `agent-lens status`、`agent-lens doctor`、`agent-lens hook status all --json`，并确认 npm 与 Desktop 仍共享同一数据根和单实例 Daemon。
- `scripts/release.ps1 -Publish` 在发布修复场景应推送当前发布分支与 Tag，不应为了发版强制覆盖 `main`。
- 发布分支上的通用修复在发版完成后必须同步回 `main`；发生冲突时保留 `main` 的新架构能力，同时保留已验证的修复语义。
