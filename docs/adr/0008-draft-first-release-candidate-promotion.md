# ADR-0008：Draft-first Release Candidate 与已验证产物晋升

- 状态：Accepted
- 日期：2026-08-28
- 范围：AgentLens 1.x 发行工程

## 背景

AgentLens 1.0 Alpha 已形成 npm + Windows + macOS + Linux 多发行形态。旧流程由“发布 GitHub Release”触发构建和 npm 发布：Release 已经对外可见之后，才开始验证真正的桌面安装包和 npm 成品。

该模式存在三个结构性问题：

1. **公开动作早于成品验证**：点击 Publish Release 后才知道某个平台是否会构建失败。
2. **验证与发布可能不是同一产物**：npm 在正式发布 Job 中重新 `npm pack`，理论上存在候选验证对象与最终发布对象漂移的可能。
3. **Release Notes 不稳定**：依赖 GitHub 自动生成说明时，如果提交没有关联 PR，正文可能退化为只有 Full Changelog。

alpha.1 的 npm 稳定化已经证明，只有真实执行 `pack → install → CLI → Daemon → native dependency → Health/Web` 才能提前发现跨平台成品问题。因此发行链需要进一步把“成品验证”前移。

## 决策

AgentLens 采用三阶段发行模型：

```text
Prepare
  ↓
Candidate / Draft Release
  ↓
Build + Smoke + Attach verified artifacts
  ↓
Publish / Promote
```

### 1. Prepare

负责版本同步、CHANGELOG 结构准备、发行检查和版本准备提交。

Prepare 不创建公开 Release，不推 npm。

### 2. Candidate

Candidate 创建并推送 `v<version>` Tag，同时创建对应 Draft Release。

Tag push 只负责启动候选构建。所有候选构建必须先通过 Draft Release Gate：

- Tag 与 package version 一致；
- Release 存在且仍为 Draft；
- prerelease 标记与 SemVer 通道一致；
- Release Notes 非空；
- Tag 最终指向当前候选 commit。

候选构建成功后，Windows/macOS/Linux/npm 产物直接挂载到 Draft Release。

### 3. Publish

Publish 不重新构建桌面产物，也不重新生成 npm tarball。

Publish 只允许在所有预期候选资产齐全时执行。npm 发布工作流从已晋升的 GitHub Release 下载 Draft 阶段生成并验证过的精确 `.tgz`，校验 SHA256 后发布。

核心规则：

> Build once, verify once, promote the verified artifact.
>
> 构建一次、验证候选、晋升同一产物。

## Release Notes 决策

`CHANGELOG.md` 当前版本段作为 Release Notes 的版本事实源。

机器负责：

- 精确抽取当前版本；
- 校验存在真实发布条目；
- 将 Added / Changed / Fixed / Known limitations 等稳定映射为 GitHub Release Notes 结构；
- 追加版本间 compare 链接。

GitHub `--generate-notes` 不再作为正式发布说明来源。PR 是否存在不应决定发布说明质量。

## npm 决策

npm 候选阶段覆盖：

- Windows x64；
- Linux x64；
- macOS ARM64；
- macOS Intel x64。

四个平台都必须安装并运行真实 tarball。最终 tarball 只生成一次，并与 SBOM、lockfile、SHA256 一起进入 Draft Release。

Release Published 事件中的 npm Job：

1. 下载该 tarball；
2. 校验 SHA256；
3. 再执行一次精确成品冒烟；
4. 校验 npm credential；
5. 将同一个文件发布到 alpha / beta / rc / latest。

禁止在正式 publish 阶段重新 `npm pack`。

## 桌面发行决策

Windows、macOS、Linux 的正式安装包也在 Candidate 阶段生成并挂到 Draft Release。

Stable 的签名/公证要求仍在候选阶段强制执行：只有真正可以对外发布的签名成品才允许进入 Draft Release 的完整候选集合。

Publish Release 后桌面工作流不重新构建。

## 失败恢复

- Draft 尚未准备好：候选门禁等待有限时间，超时后安全失败。
- Tag 已推送、Draft 创建失败：允许在 Tag 仍指向同一 commit 时补建 Draft，再重跑失败 Job。
- 任一候选产物失败：不允许 Publish。
- 已公开版本出现代码修复：创建新版本/新 Tag，不移动旧 Tag。
- npm 凭据失败：修复凭据后仍发布原候选 `.tgz`，不重新打包。

## 不做

当前不引入：

- Cloudflare R2；
- Homebrew / Scoop 自动同步；
- CNB 镜像发布；
- AI 自动翻译 Release Notes；
- 官网 Changelog JSON 投影。

这些属于未来分发能力，不是 Draft-first 发行模型成立的前置条件。

## 影响

### 正向

- Release 对外公开前即可知道所有主平台成品是否可用；
- npm 做到“验证对象 = 发布对象”；
- Release Notes 不再依赖 PR 关联质量；
- 失败恢复边界明确；
- Alpha/Beta/RC/Stable 共用同一发行模型。

### 代价

- 发版从单步 Publish 变为 Candidate + Publish 两个明确阶段；
- 候选工作流需要 GitHub Release 写权限；
- Release Notes 必须在候选前维护，而不能完全依赖 GitHub 自动生成。

该代价可接受，因为它换取了更强的发行确定性和可审计性。
