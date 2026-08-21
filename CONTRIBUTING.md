# 参与 AgentLens 开发

AgentLens 1.0 是一次 Clean Rebuild。当前工作树只保留 1.0 实现；0.x 代码需要参考时请通过 Git 历史 / Tag 查阅，不要把旧 Runtime 直接恢复回来。

## 开始之前

架构或 Contract 相关修改前，依次阅读：

1. `ARCHITECTURE.md`
2. `docs/1.0/CORE-CONTRACT.md`
3. `docs/adr/0001-agentlens-1.0-clean-rebuild-and-cordis-runtime.md`
4. `AGENTS.md`

Issue、Milestone、Project 和 Pull Request 以 GitHub 为准。安全问题请按 `SECURITY.md` 私密报告。

## 本地开发

要求 Node.js **22.23+**。

```bash
npm install
npm run typecheck
npm test
npm run build:dist
npm pack --dry-run
```

开发运行：

```bash
npm run dev
```

Web 单独开发：

```bash
npm run dev:web
```

CLI：

```bash
npm run cli -- doctor
npm run cli -- hook status all
npm run cli -- start
```

默认 1.0 数据目录是：

```text
~/.agent-lens/1.0/
```

其中可能包含 Session、Tool 参数、Evidence、配置路径和其他本机数据。禁止提交真实运行数据、数据库、Prompt、Token、凭据或本机绝对路径。

## 当前仓库结构

```text
apps/
  cli/ daemon/ web/ desktop/ hook-codex/ hook-claude/

packages/
  core/ core-services/ runtime-cordis/ protocol/
  storage-sqlite/
  source-codex/ source-claude/ source-pi/
  projection-timeline/ projection-session/ projection-usage/
  surface-http/ hook-manager/
```

不要新增根级 `server/`、`src/` 或 `test/` 来承载 1.0 Runtime / UI / Test。

## Pull Request 要求

Pull Request 应满足：

- 标题和正文统一使用中文；
- 只解决一个明确问题；
- 描述背景、实现、风险和验证结果；
- 新行为有相应测试，或说明无法自动测试的原因；
- `npm run typecheck`、`npm test`、`npm run build:dist` 通过；
- 不包含真实提示词、凭据、本机数据；
- Web 只消费 `@agent-lens/protocol` / `/api/v1/*`；
- Source 通过稳定 `SourceDefinition` Contract 接入，并由 Cordis-native Plugin 入口注册；
- 不把静态 Asset Discovery 当作实际 Usage；
- 不重新引入 0.x Adapter / Importer / timeline / overview Runtime；
- 涉及 Core Contract、Canonical Identity、Evidence 语义或 Runtime 所有权时，先做 Contract Review / ADR。

## 提交风格

提交信息统一使用中文，推荐保持清晰的“类型（范围）：说明”结构，例如：

```text
功能(1.0)：新增来源能力
修复(1.0)：保留证据身份
文档(1.0)：澄清运行时边界
```

代码标识符、API 名称、类型名和命令仍保持英文，不要求为了提交语言翻译技术标识符。

## 文档职责

- `README.md` / `README.zh-CN.md`：对外能力和使用方式；
- `ARCHITECTURE.md`：当前真实架构；
- `docs/1.0/CORE-CONTRACT.md`：稳定 Contract；
- `docs/adr/*`：长期、难以逆转的架构决策；
- `docs/1.0/IMPLEMENTATION-STATUS.md`：当前 1.0 实现与验证状态；
- `CHANGELOG.md`：历史发布记录。

不要把计划中的能力写成已经实现的能力。
