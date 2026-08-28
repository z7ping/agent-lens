# AgentLens 1.0 发版流程

AgentLens 采用 **Prepare → Candidate → Publish** 三阶段发行模型。

核心原则：

1. GitHub Release 在候选阶段必须保持 **Draft**。
2. Windows、macOS、Linux 与 npm 成品必须在 Draft 阶段完成构建、安装/运行冒烟和校验。
3. 正式 Publish 只是“晋升已经验证过的候选”，不能重新构建桌面包，也不能重新 `npm pack`。
4. npm 必须发布 Draft 阶段生成并经过四平台真实安装验证的同一个 `.tgz`。
5. `CHANGELOG.md` 当前版本段是 Release Notes 的源；GitHub Release Notes 由脚本确定性生成，不使用 `--generate-notes` 猜测。

## 1. 前置条件

- 工作区必须干净；不要把私密仓库文件带入公开仓库。
- 已安装 Node.js 22、GitHub CLI，并完成 `gh auth status` 登录。
- 版本使用 SemVer，例如 `1.0.0-alpha.2`、`1.0.0-beta.1`、`1.0.0-rc.1`、`1.0.0`。
- Git Tag 固定使用 `v<version>`，例如 `v1.0.0-alpha.2`。
- Alpha / Beta / RC 可以生成未签名 Windows/macOS 狗粮包；Stable 必须通过 Windows 签名和 macOS 签名/公证门禁。
- 建议从独立 `release/<version>` 分支准备版本；发版完成后把通用修复同步回 `main`，不要用 release 分支覆盖后续功能开发。

## 2. 阶段一：Prepare（版本准备）

预览下一个版本，不修改文件：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Preview
```

正式准备版本：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1
```

默认 `Auto` 规则：

- `1.0.0-alpha.1 -> 1.0.0-alpha.2`
- `1.0.0-beta.1 -> 1.0.0-beta.2`
- `1.0.0-rc.1 -> 1.0.0-rc.2`
- 正式版 `1.0.0 -> 1.0.1`

需要明确升级时可以使用：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -ReleaseType Stable
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -ReleaseType Minor
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -ReleaseType Major
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version 1.0.0-beta.1
```

Prepare 会：

- 同步根包、全部 workspace、内部 `@agent-lens/*` 依赖和 `package-lock.json` 版本；
- 同步源码中的正式版本常量；
- 为 `CHANGELOG.md` 创建结构化版本骨架；
- 执行 `release:check`；
- 创建“发布准备 AgentLens <version>”提交；
- **不会创建 Tag，不会创建 Release，不会对外发布。**

版本骨架采用：

```markdown
## 1.0.0-alpha.2（YYYY-MM-DD）

### Added

### Changed
- 版本更新至 1.0.0-alpha.2，详见本次发布说明。

### Fixed

### Known limitations
```

其中“版本更新至……”只是占位文案。进入 Candidate 前必须由开发者或 Agent 替换为真实变更并提交。只有占位文案时，Release Notes 门禁会拒绝创建候选。

## 3. Release Notes 生成规则

候选阶段使用：

```powershell
npm run release:notes -- --previous-tag v1.0.0-alpha.1
```

底层脚本为：

```text
scripts/render-release-notes.mjs
```

它只读取 `CHANGELOG.md` 的当前版本段，并确定性映射为 GitHub Release Notes：

- `Added` → `新增`
- `Changed` / `Improved` → `改进`
- `Fixed` → `修复`
- `Security` → `安全`
- `Removed` → `移除`
- `Known limitations` → `已知限制`

没有目标版本、没有发布条目、或仍只有自动升版占位文案时直接失败。

## 4. 阶段二：Candidate（创建 Draft Release 候选）

确认 `CHANGELOG.md` 已完善并提交后执行：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version 1.0.0-alpha.2 -Candidate
```

Candidate 会：

1. 再跑完整发行检查；
2. 从 `CHANGELOG.md` 生成结构化 Release Notes；
3. 创建 annotated Tag `v<version>`；
4. 原子推送当前提交与 Tag；
5. 创建对应 **Draft Release**；
6. Alpha/Beta/RC 自动标记为 prerelease；
7. Tag push 启动候选构建流水线。

候选构建开始时会验证：

- Tag 与 `package.json` 版本一致；
- 对应 GitHub Release 已存在且仍是 Draft；
- prerelease 标记与版本通道一致；
- Release Notes 非空并明确包含当前版本；
- 远端 Tag 最终解析到当前候选 commit。

由于 Tag push 与 Draft Release 创建存在很短的事件竞态，候选门禁会等待 Draft Release 最多 120 秒；不会因为几秒钟的 GitHub API 延迟误判。

## 5. Draft 阶段构建什么

### Windows

`Windows Installer Candidate`：

- 构建 NSIS 安装包；
- 打包后运行冒烟；
- 真实静默安装；
- 覆盖升级；
- 数据保留；
- 卸载；
- Stable 校验签名；
- 生成 SHA256；
- 成功后挂到 Draft Release。

### macOS

覆盖：

- Apple Silicon / ARM64；
- Intel / x64；
- DMG + ZIP；
- 打包后 Runtime 冒烟；
- Stable 强制签名、公证和 stapler 校验；
- 生成 SHA256；
- 成功后挂到 Draft Release。

### Linux

覆盖：

- x64；
- ARM64；
- AppImage；
- deb；
- 打包后 Runtime 冒烟；
- 生成 SHA256；
- 成功后挂到 Draft Release。

### npm

`npm Release Candidate`：

- Ubuntu x64；
- Windows x64；
- macOS ARM64；
- macOS Intel x64；
- 每个平台都执行 `npm pack → 干净 consumer npm install → installed CLI → installed Daemon → better-sqlite3 → Health → Web`；
- npm Registry 凭据预检；
- 四平台全部成功后只在 Ubuntu 生成一次最终 `.tgz`；
- 生成 SBOM、`package-lock.json` 快照和 SHA256；
- 再对最终 `.tgz` 做一次精确成品冒烟；
- 成功后挂到 Draft Release。

## 6. 阶段三：Publish（晋升候选）

不要在 GitHub 页面提前点击 Publish。

所有候选工作流完成后执行：

```powershell
pwsh -NoLogo -NoProfile -File .\scripts\release.ps1 -Version 1.0.0-alpha.2 -Publish
```

Publish 前会检查 Draft Release 是否具备全部预期资产：

- npm `.tgz`、SBOM、lockfile、SHA256；
- Windows x64 安装器和 SHA256；
- macOS ARM64 / Intel 的 DMG、ZIP、SHA256；
- Linux x64 / ARM64 的 AppImage、deb、SHA256。

缺任意一个文件都会拒绝 Publish。

晋升成功后：

- Draft Release 变为正式发布的 Release / Pre-release；
- Windows、macOS、Linux **不会重新构建**；
- `Publish AgentLens 1.0` 只下载 Release 中已经验证过的 npm `.tgz`；
- 校验 `SHA256SUMS-npm.txt`；
- 对同一个 `.tgz` 再做一次安装运行冒烟；
- `npm whoami` 成功后发布这个精确 `.tgz`；
- alpha / beta / rc 分别进入对应 npm dist-tag，Stable 进入 `latest`。

这条规则称为：**验证什么，就发布什么（build once, promote the verified artifact）**。

## 7. 发布后核对

```powershell
$version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
gh release view "v$version" --repo z7ping/agent-lens
gh run list --repo z7ping/agent-lens --limit 20
npm view @z7ping/agent-lens@$version version
npm view @z7ping/agent-lens dist-tags
```

npm 实装：

```powershell
npm install -g @z7ping/agent-lens@alpha
agent-lens --version
agent-lens status
agent-lens doctor
```

## 8. 失败恢复

### Tag 已推送，但 Draft Release 创建失败

不要删除 Tag。确认 Tag 仍指向正确候选提交后，再执行相同 `-Version <version> -Candidate`。脚本允许复用指向当前 HEAD 的本地/远端 Tag，并补建或更新 Draft Release。

如果候选工作流已经因为等待 Draft 超时失败，在 Draft Release 补好后，从 GitHub Actions 对原 Tag run 执行 Re-run failed jobs。

### 某个平台候选失败

不要 Publish。修复代码后必须使用新的版本号 / Tag 重新建立候选；已经公开使用的 Tag 不移动。

### Draft Release Notes 需要修改

在 Publish 前可以修正 `CHANGELOG.md` 并重新生成 Notes，但如果修改导致候选 commit 改变，必须重新建立新版本候选。Release Notes 的文字修订如果不改变构建代码，也应同步回 `CHANGELOG.md`，避免事实源分叉。

### npm 正式发布失败

不要重新 pack。修复发布凭据或发布步骤后，必须继续使用 GitHub Release 中已经验证过的同一个 `.tgz`。

## 9. 禁止事项

- 禁止从带有未计划功能的 `main` 错误打 Release Tag。
- 禁止在候选资产未齐时提前 Publish Release。
- 禁止手工执行新的 `npm pack` 后直接发布。
- 禁止移动已经对外使用的版本 Tag。
- 禁止让 GitHub `--generate-notes` 成为正式 Release Notes 来源。
- 禁止 Stable 绕过 Windows/macOS 签名与公证门禁。
