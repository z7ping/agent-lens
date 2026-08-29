# 参与 AgentLens 开发

AgentLens 1.0 是一次 Clean Rebuild。当前代码仓库只维护 1.0 实现；0.x 代码需要参考时请通过 Git 历史 / Tag 查阅，不要把旧 Runtime 直接恢复回来。

## 开始之前

架构或 Contract 相关修改前，先阅读：

1. [`ARCHITECTURE.md`](ARCHITECTURE.md)
2. [`docs/1.0/CORE-CONTRACT.md`](docs/1.0/CORE-CONTRACT.md)
3. [`docs/1.0/IMPLEMENTATION-STATUS.md`](docs/1.0/IMPLEMENTATION-STATUS.md)

Issue、Milestone、Project 和 Pull Request 以 GitHub 为准。安全问题请按 [`SECURITY.md`](SECURITY.md) 私密报告。

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

`npm run dev` 只影响源码开发运行时，不改变正式安装版的固定端口和数据目录。开发启动器默认从 `127.0.0.1:56789` 开始探测；端口已被占用时按 `56790 / 56791 / ...` 顺序自动退避，最多尝试 21 个端口。需要从其他端口开始时可设置 `AGENT_LENS_DEV_PORT`。

开发 Daemon 不与正式运行时共用 SQLite / Backup Vault。每个实际开发端口使用仓库内独立目录：

```text
.agent-lens/dev/<port>/agent-lens.db
.agent-lens/dev/<port>/vault/
```

因此本机已安装并运行 AgentLens Desktop 时，也可以直接执行 `npm run dev`；正式运行时继续使用 `56789 + ~/.agent-lens/1.0/`，源码开发运行时会自动选择后续空闲端口并隔离数据。`.agent-lens/` 已被 Git 忽略，不得把开发数据库提交到仓库。

Web：

```bash
npm run dev:web
```

`dev:web` 仍是纯 Web 开发入口；需要直接验证正式运行时真实数据时，可以让 Web 开发服务器连接当前正式 Daemon，不必额外启动第二个完整运行时。

CLI：

```bash
npm run cli -- doctor
npm run cli -- hook status all
npm run cli -- start
```

正式 1.0 默认数据目录：

```text
~/.agent-lens/1.0/
```

其中可能包含 Session、Tool 参数、Evidence、配置路径和其他本机数据。禁止提交真实运行数据、数据库、Prompt、Token、凭据或本机绝对路径。

## 关键开发边界

- Web 只消费 `@agent-lens/protocol` / `/api/v1/*`，不得直接访问 SQLite 或 Source 实现。
- Source 通过稳定 `SourceDefinition` Contract 接入，并由 Cordis-native Plugin 注册。
- 静态 Asset Discovery 不能冒充实际 Usage。
- 不重新引入 0.x Adapter / Importer / timeline / overview Runtime。
- npm 与 Desktop 共用同一正式 Runtime 与 Canonical 数据模型；开发运行时只允许通过独立端口和独立开发数据目录并行，禁止两个 Daemon 同时写同一份正式 SQLite。
- 缓存与 Projection 优化必须可由 Canonical 数据重建。
- 修改 Core Contract、Canonical Identity、Evidence 语义或 Runtime 所有权时，必须先完成架构审查。

## Pull Request

Pull Request 应满足：

- 标题和正文优先使用中文；
- 一次只解决一个明确问题；
- 描述背景、实现、风险和验证结果；
- 新行为有对应测试，或说明无法自动测试的原因；
- 至少完成与改动范围对应的 `typecheck / test / build`；
- 不包含真实提示词、凭据、本机数据或其它敏感资料。

## 文档职责

公开代码仓库只维护实现和使用所需的最小文档：

- `README.md` / `README.en.md`：对外能力和使用方式；
- `ARCHITECTURE.md`：当前真实架构边界；
- `docs/1.0/CORE-CONTRACT.md`：稳定 Contract；
- `docs/1.0/IMPLEMENTATION-STATUS.md`：当前实现与验证状态；
- `CHANGELOG.md`：发布记录；
- `SECURITY.md`：安全报告方式。

历史 ADR、高保真原型、内部产品方向、设计过程和 Agent 协作知识不在公开代码仓库维护。

不要把计划中的能力写成已经实现的能力。
