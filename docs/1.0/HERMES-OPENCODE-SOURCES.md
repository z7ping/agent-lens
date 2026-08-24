# Hermes / OpenCode Source 接入说明

更新日期：2026-08-24

## 结论

Hermes 与 OpenCode 已按 AgentLens 1.0 Source Contract 重新接入，不恢复 0.x Adapter / Importer Runtime。

两个来源都作为独立 Cordis-native Source Plugin 注册到 Daemon Composition Root：

```text
@agent-lens/source-hermes
@agent-lens/source-opencode
        ↓
ctx.sources.register(SourceDefinition)
        ↓
SourceRecord
        ↓
normalize()
        ↓
ObservationCandidate + EvidenceCandidate
        ↓
Canonical Observation + Evidence
```

不得把 0.x 的 `Adapter -> timeline/session 表` 直接写入方式接回 1.0。

## Hermes

### 默认事实源

Hermes 默认使用本机 `state.db`：

- History：启动时按 Checkpoint 增量回填；
- Runtime Tail：监听数据库目录变化，并使用短周期扫描兜底；
- 对同一消息行的内容变化按指纹识别，避免只按 rowid 水位线漏掉原地更新；
- Evidence 类型为 `native-db`。

路径支持：

- `HERMES_HOME` 显式覆盖；
- Windows `%LOCALAPPDATA%/hermes`；
- 用户目录 `~/.hermes`。

### 实时观察增强

Hermes 官方插件 Hook 是可选增强，不作为 AgentLens Daemon 的第二套 Runtime。

AgentLens 随发行包提供 `agent-lens-observer` 被动观察插件：

```text
Hermes Hook
  ↓
AgentLens observer plugin
  ↓
~/.agent-lens/1.0/inbox/hermes/*.json
  ↓
Hermes Source.startCapture()
  ↓
Canonical Pipeline
```

观察插件约束：

- 只使用 Python 标准库；
- 只清洗、截断并原子写 Durable Inbox；
- 不调用 AgentLens HTTP；
- 不读取 / 写入 AgentLens SQLite；
- 不依赖 Core / Cordis；
- 回调失败必须 fail-open；
- 不返回行为修改指令；
- 不自动启用。

Hermes 第三方插件本身采用显式启用模型，因此 AgentLens 不在 `setup` 中静默启用该插件。用户明确启用后，实时 Hook Evidence 与 `state.db` Evidence 仍进入同一个 Hermes Source。

当前发行包内插件位置：

```text
dist/integrations/hermes/agent-lens-observer/
```

后续若增加 CLI 安装/启用入口，也只能把“复制插件”和“用户显式启用”作为运维动作，不得把插件生命周期搬进 Core Runtime。

### 资产发现

当前重新实现：

- Skills：`skills/**/SKILL.md`；
- Plugins：`plugins/`；
- MCP：`mcp-servers/` 与 `config.yaml` 中 `mcp_servers`；
- Toolsets：`config.yaml` 中 `toolsets / platform_toolsets`；
- Memories：`memories/`。

静态发现只形成 Asset / Asset State，不等同于实际调用。

## OpenCode

OpenCode 使用原生 `opencode.db`，不额外安装 Hook。

### 历史采集

读取关系：

```text
part
  ├─ message -> role / model 等消息语义
  └─ session -> directory / workspace
```

当前映射：

- `text + user` -> `message.user`；
- `text + assistant` -> `message.assistant`；
- `reasoning` -> `message.reasoning`（仅来源可见内容）；
- `tool` -> `tool.call / tool.result`；
- step start / finish -> `session.lifecycle`；
- 未确认的 part 类型保留为 `unknown`，不猜测语义。

History 使用 `part.rowid` Checkpoint 分批增量回填。

### 运行时采集

OpenCode 沿用 0.x 已验证的“原生数据库变化驱动 + 周期兜底”经验，但输出改为 SourceRecord：

```text
opencode.db / WAL 变化
        ↓
目录 fs.watch
        +
短周期兜底扫描
        ↓
最近行 rowid + fingerprint
        ↓
SourceRecord(native-db)
        ↓
Canonical Pipeline
```

不能只按“新增 rowid”观察，因为 OpenCode 的工具 part 可能在同一行从 running 原地更新到 completed；1.0 Runtime Tail 会同时比较行指纹，从而捕获这类状态更新。

路径支持：

- `OPENCODE_HOME` 显式覆盖；
- Windows `%APPDATA%/opencode`；
- Linux/macOS `XDG_DATA_HOME/opencode` 或 `~/.local/share/opencode`。

## Cordis 边界

Hermes / OpenCode 的加入不改变现有 Cordis 架构：

- Cordis 继续是唯一 Plugin Runtime；
- Daemon 只通过 `app.use(sourcePlugin)` 装配；
- Source Plugin 只注册 `SourceDefinition`；
- 通用 Runner 不增加按来源判断；
- History / Runtime / Asset 都必须走通用 Source Runner；
- Source 不直接写 Canonical Repository；
- Web 不直接依赖任何 Source package。

因此，本次是“增加两个 Cordis Source 插件”，不是“新增一套适配器运行时”。

## 验收重点

自动验收应覆盖：

1. Hermes `state.db` 历史：用户 / 智能体 / 工具调用 / 工具结果；
2. Hermes 资产扫描；
3. Hermes Durable Inbox 可形成 Runtime Hook Observation；
4. Hermes Hook 插件写入失败不会影响 Hermes；
5. OpenCode History 能读取 `message + part + session`；
6. OpenCode 同一 tool part 原地更新后补出 `tool.result`；
7. 两个 Source History Replay 均保持幂等；
8. History 与 Runtime 观察到同一稳定原生标识时，仍通过 Canonical Dedup 合并 Evidence；
9. Daemon 仍只有一个 Cordis Application / 一个默认数据库 / 一套 Source Runner。
