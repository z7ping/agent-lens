# 参与 AgentLens 开发

感谢你关注 AgentLens。项目的界面文本、开发文档和 Issue 沟通统一使用中文。

## 唯一事实来源

- [GitHub Issues](https://github.com/z7ping/agent-lens/issues)：缺陷、需求和开发任务。
- GitHub Milestones：版本范围和完成度。
- GitHub Projects：任务状态。
- GitHub Pull Requests：代码评审和合并。
- [CHANGELOG.md](CHANGELOG.md)：已经发布的变化。

Gitea 仅作为代码镜像或备份，不在那里创建、更新或关闭 Issue、Milestone、Project 和 Pull Request。仓库本地远端名称不代表治理平台；即使某个工作副本将 Gitea 命名为 `origin`，任务和评审仍以 GitHub 为准。

## 提交问题

请优先使用仓库提供的 Issue 模板：

- 缺陷报告：描述复现步骤、预期结果、实际结果和环境。
- 功能建议：描述用户问题、目标结果和不做的范围。
- 开发任务：用于已经确定方案、可以直接实施的工作。

安全漏洞、提示词泄露、凭据暴露或未经授权的远程访问问题，请不要创建公开 Issue，改用 [SECURITY.md](SECURITY.md) 中的私密报告方式。

## 开始开发前

1. 搜索是否已有重复 Issue。
2. 对非小型修复先创建或认领 Issue。
3. 确认 Issue 的目标、非目标和验收标准。
4. 涉及事件模型、数据库、安全边界或公共适配器协议时，先在 GitHub Issue 中与维护者确认方案，再开始大规模实现。

## 本地开发

环境要求：Node.js 18 或更高版本。

```bash
npm install
npm run dev
```

常用验证命令：

```bash
npm test
npm run build
```

运行时数据会写入项目根目录 `.agent-lens/`。禁止提交该目录、真实会话、提示词、配置文件、数据库、Token 或其他本机数据。

## 分支与提交

建议分支名称带上 Issue 编号：

```text
feat/123-codex-context-lens
fix/124-timeline-dedup
docs/125-install-guide
```

提交信息使用简洁的中文或约定式前缀：

```text
feat: 捕获 Codex 用户提示词
fix: 修复并行事件错误去重
docs: 补充配置透镜设计说明
```

在提交或 Pull Request 中使用 `Refs #123` 关联任务；确认合并后应关闭任务时，在 Pull Request 描述中使用 `Closes #123`。

## Pull Request 要求

Pull Request 应满足：

- 只解决一个明确问题，避免混入无关修改。
- 描述背景、实现、风险和验证结果。
- 关联对应 GitHub Issue。
- 新行为有相应测试，或说明无法自动测试的原因。
- `npm test` 和 `npm run build` 通过。
- 面向用户的字符串和文档使用中文。
- 不包含真实提示词、凭据、本机绝对路径和运行时数据。
- 数据库变更包含向前迁移和旧数据兼容验证。
- 新适配器明确标注捕获、诊断、扫描、推断和不可观察能力。

## 文档职责

- README：用户当前可以使用的能力。
- CHANGELOG：已经发布了什么。
- ARCHITECTURE：当前真实架构和已知限制。

不要在多个文档中重复维护任务状态。任务是否进行中、由谁负责以及是否阻塞，以 GitHub Issue 和 Project 为准。
