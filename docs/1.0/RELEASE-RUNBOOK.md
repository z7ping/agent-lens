# AgentLens 1.0 发版流程

## 1. 前置条件

- 工作区必须干净；不要把私密仓库文件带入公开仓库。
- 已安装 Node.js 22、GitHub CLI，并完成 `gh auth status` 登录。
- 当前仓库的 GitHub Actions Secrets 已配置：预发布可以不配置签名凭据；正式版需要 Windows 和 macOS 签名/公证凭据。
- 版本号使用 SemVer，例如 `1.0.0-alpha.1`、`1.0.0-beta.1`、`1.0.0`。
- 发布修复建议从目标基线切 `release/<version>` 分支；该分支只接收本次发版修复，不混入下一阶段功能开发。

## 2. 一键准备版本

先预览将会修改的文件：

```powershell
npm run release:version -- 1.0.0-alpha.1 --dry-run
```

确认后执行同步：

```powershell
npm run release:version -- 1.0.0-alpha.1
```

该命令会同步根包、所有 workspace 包、内部依赖锁定版本、CLI/插件运行时版本、发行冒烟断言和 CHANGELOG，并保留旧版本章节。

## 3. 本地检查并创建提交/Tag

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version 1.0.0-alpha.1
```

默认会执行完整 `release:check`，然后创建：

- 提交：`发布 AgentLens 1.0.0-alpha.1`
- Tag：`v1.0.0-alpha.1`

该模式不会推送远端，适合先检查提交和 Tag。

## 4. 发布前升级回归

预发布也必须至少验证上一已发布版本到当前候选版本的真实升级路径，不只验证“同一个安装包覆盖自己”。

### Windows Desktop

从 GitHub Release 安装上一版本（例如 `v1.0.0-alpha.0`），制造少量真实 AgentLens 数据并确认 Daemon / Web / Hooks 正常，再直接安装当前候选安装包。升级后检查：

- `~/.agent-lens/1.0` 数据目录仍保留，数据库可以正常读取；
- Daemon 能正常启动，`status` / `doctor` 无生命周期异常；
- 已安装 Hooks 仍指向有效的共享分发器；
- 登录自启设置不因覆盖升级丢失；
- Desktop 能打开正式 Web，任务复盘、智能体概览和资产备份可正常读取旧数据；
- 日志仍写入当前约定目录，没有重新产生旧版目录。

### npm / CLI

在上一版本已安装并已有数据的环境中升级到当前候选版本，至少检查：

```powershell
npm install -g @z7ping/agent-lens@alpha
agent-lens status
agent-lens doctor
agent-lens hook status all --json
```

确认 npm / Desktop 仍共享同一个 1.0 数据根和单实例 Daemon，不产生第二套数据或陈旧 Hook Provider。

真实升级回归未完成时，不创建最终 Release。

## 5. 推送并创建 GitHub Release

确认本地提交、Tag、三平台 CI 和升级回归无误后执行：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version 1.0.0-alpha.1 -Publish
```

脚本会推送当前 `HEAD` 所在发布分支、推送 Tag，并创建 GitHub Release；不会强制切换或推送 `main`。带 `alpha` / `beta` / `rc` 的版本自动标记为 Pre-release；GitHub Release 发布后，Windows、macOS/Linux 和 npm 工作流会自动运行。

发布分支上的通用修复在发版完成后必须同步回 `main`，避免后续开发重新引入已经修复的问题。

## 6. 发布后核对

```powershell
gh run list --repo z7ping/agent-lens --limit 10
gh release view v1.0.0-alpha.1 --repo z7ping/agent-lens
npm view @z7ping/agent-lens versions --json
```

预发布版本发布到 npm 的 `alpha` / `beta` / `rc` dist-tag；稳定版发布到 `latest`。不要重复使用已经存在的版本号或 Tag。

## 7. 常见失败

- `Release tag ... does not match package version ...`：Tag、根 `package.json` 和锁文件版本没有同步，重新运行版本同步命令。
- `git@github.com: Permission denied` 且路径包含 `release/*.tgz`：必须使用工作流中的 `./release/...tgz` 文件路径，不能让 npm 将它当作 Git 依赖解析。
- Windows/macOS 正式版签名门禁失败：配置对应的 Actions Secrets；Alpha/Beta/RC 可以生成未签名狗粮包。
- Release 页面已有同名 Tag：不要删除历史 Release，升级 patch 或 prerelease 序号后重新发版。
