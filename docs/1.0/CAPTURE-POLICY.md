# AgentLens 1.0 采集隐私策略

更新日期：2026-08-27  
状态：1.0 P0 稳定化基线

AgentLens 通过独立的 `@agent-lens/capture-policy` 插件统一控制**来源启用边界**与**持久化边界**上的采集行为。该插件是独立实现，但在官方 Daemon 中属于**强制基础插件**：禁用 Source 不得进入 Detect / History / Runtime / Asset 流程，启用 Source 也不能绕过隐私门禁把原始正文写入 1.0 数据库。

多机 Hub 引入后，还必须增加独立的 **Replication Policy（复制策略）**：本机允许持久化的数据，不等于自动允许离开本机进入 Hub。Capture Policy 与 Replication Policy 是两道不同门禁。

## 1. 为什么是独立插件

Source 负责回答“来源暴露了什么、如何解析”；采集策略负责回答“这个来源是否允许采集、哪些内容允许持久化”。两者必须分离：

```text
Registered Source
  ↓
Source allowlist
  ├─ disabled → 不 Detect / 不 History / 不 Runtime / 不 Asset
  └─ enabled
       ↓
Normalize（只在内存处理原始记录）
       ↓
CapturePolicy
  ├─ SourceRecord 持久化边界
  ├─ Canonical Observation 持久化边界
  └─ 静态 Asset 持久化边界
       ↓
SQLite / Projection / Surface
```

`@agent-lens/core` 只声明 `CapturePolicyService` 契约，不依赖 Cordis。`@agent-lens/capture-policy` 实现该契约，并由 Cordis Runtime 以 `ctx.capturePolicy` 提供给通用 Source Runner。各 Source 不直接依赖采集策略插件实现。

## 2. 按来源控制是否采集

来源开关使用一个完整允许列表：

```text
AGENT_LENS_ENABLED_SOURCES
```

默认值只启用 Claude Code：

```text
claude-code
```

当前官方 Source ID：

| 来源 | Source ID | 默认启用 |
| --- | --- | --- |
| Claude Code | `claude-code` | 是 |
| Codex | `codex` | 否 |
| Pi | `pi` | 否 |
| Hermes | `hermes` | 否 |
| OpenCode | `opencode` | 否 |

显式启用多个来源时使用逗号分隔，例如：

```text
AGENT_LENS_ENABLED_SOURCES=claude-code,codex,pi,hermes,opencode
```

显式关闭所有来源：

```text
AGENT_LENS_ENABLED_SOURCES=none
```

来源 ID 按不区分大小写处理，并去除首尾空白。允许列表不硬编码为上述五种来源；后续第三方 Source 仍可使用自己的稳定 `sourceId`。

### 2.1 禁用来源的边界

禁用来源必须在任何来源 I/O 之前被挡住：

```text
Registered Source
→ Source allowlist
→ Detect
→ History / Runtime / Asset
```

因此禁用来源：

- 不执行 `SourceDefinition.detect()`；
- 不同步 History；
- 不启动 Runtime Capture / Native Tail；
- 不执行 Asset Discovery；
- 不注册新的 Installation Detection 结果；
- 不产生新的 Canonical Observation / Evidence / Asset 数据。

“插件已注册”只表示该 Source 能力随 AgentLens 安装，不等于“用户允许采集”。通用 Source Runner 只依据 `CapturePolicyService.isSourceEnabled(sourceId)` 判断是否进入采集流程，不允许在 Runner 中增加 Codex / Claude / Pi / Hermes / OpenCode 专用分支。

### 2.2 Hook / Observer 也必须遵守同一开关

Codex、Claude Code 的被动 Hook，以及 Hermes 可选 Observer，都必须在写 Durable Inbox 前遵守 `AGENT_LENS_ENABLED_SOURCES`：

- Claude Code 默认允许写 Inbox；
- Codex 默认不写 Inbox，只有显式启用 `codex` 后才写；
- Hermes Observer 即使已经由用户显式安装 / 启用，默认仍不写 Inbox，只有显式启用 `hermes` 后才采集；
- Hook / Observer 继续保持 fail-open，来源关闭或策略读取失败不得阻断上游 Agent。

Hook / Observer 不加载 Core、Cordis 或 SQLite；它们只复用相同的环境变量语义，不引入第二套运行时。

修改来源允许列表后，需要重启 AgentLens Daemon；对于 Hook / Observer，还应重启对应 Agent 进程，使其继承同一环境变量。来源关闭不会自动删除此前数据库或 Inbox 中已经存在的数据；历史清理仍属于独立动作。

## 3. 四类内容采集范围

| 范围 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 提示词 / 对话 | `AGENT_LENS_PROMPT_CAPTURE` | `redacted` | 用户、智能体、可观察过程片段、上下文摘要正文 |
| 工具数据 | `AGENT_LENS_TOOL_CAPTURE` | `redacted` | 工具输入、输出、权限与产物操作内容 |
| 配置 / 静态资产 | `AGENT_LENS_CONFIG_CAPTURE` | `redacted` | Skill、MCP、Plugin、Hook 等静态发现结果 |
| 环境信息 | `AGENT_LENS_ENV_CAPTURE` | `off` | 预留给显式环境采集；1.0 当前不会因为开启策略就主动新增环境变量采集 |

可选值统一为：

```text
off | redacted | full
```

非法值回退到上述默认值。

来源允许列表与四类内容档位是正交关系：先判断 Source 是否启用，再对已启用来源的 Prompt / Tool / Config / Environment 内容应用对应档位。

## 4. 三个档位的语义

### `off`

不持久化该范围的正文，但尽量保留观察轨迹所需的最小结构事实。

- Prompt / Message：事件仍存在，正文替换为“未采集”标记。
- Tool：保留工具名、状态、成功标志、耗时、调用标识等统计元数据；参数、命令、输入输出正文不持久化。
- Raw `SourceRecord`：如果记录属于关闭的 Prompt / Tool 范围，原始 `payload` 写库前置为 `null`。
- Config：直接跳过 `discoverAssets()`，不读取并持久化静态资产盘点结果。

`off` 不等于“假装事件没发生”。Session / Tool 轨迹、Evidence 身份和可观测覆盖仍应尽可能保留。

### `redacted`

持久化正文，但执行统一脱敏和严格长度限制：

- 明确凭据字段（Token、API Key、Password、Cookie、Authorization 等）始终遮蔽；
- Bearer / Basic、GitHub / Slack Token、JWT、常见查询参数凭据会按高置信规则遮蔽；
- Prompt / Tool / Environment 正文中的常见本机用户主目录用户名会遮蔽；静态资产绑定路径作为可管理的资产定位元数据保留，但其中的明确凭据仍强制遮蔽；
- 数组、对象键数量和长文本设上限，避免把无界原始载荷写入数据库。

### `full`

保留普通正文和普通本机路径，使用比 `redacted` 更宽的长度上限；但**明确凭据保护不可关闭**。即使选择 `full`，Token、API Key、Password、Authorization、Cookie 等高置信凭据仍会被遮蔽。

这是 1.0 相比 0.x 更严格的安全边界：`full` 表示“完整业务正文”，不是“允许把已识别凭据明文落库”。

## 5. SourceRecord 的处理顺序

0.x / 早期 1.0 Runner 曾先执行：

```text
sourceRecords.put(raw)
→ normalize(raw)
```

这会导致 Canonical 层即使脱敏，原始正文仍已经落库。

1.0 P0 调整后必须执行：

```text
raw SourceRecord（内存）
→ Source.normalize(raw)
→ CapturePolicy.sanitizeSourceRecord(raw, normalized)
→ CapturePolicy.sanitizeNormalizedOutput(normalized)
→ 持久化安全 SourceRecord
→ commit 安全 Observation / Evidence / Coverage
```

如果 Normalize 本身失败，Runner 也只能写入经过保守策略处理后的 SourceRecord，禁止为了诊断而回退到原始明文持久化。

## 6. 配置关闭的边界

`AGENT_LENS_CONFIG_CAPTURE=off` 会阻止 Source Runner 调用静态 `discoverAssets()`，因此不会新建 Skill / MCP / Plugin / Extension / Hook 等静态资产盘点结果。

它**不会**关闭 Source Detection、History 或 Runtime Capture；AgentLens 仍需要最小安装/数据根信息来定位原生数据源并保持 Installation 身份稳定。这些运行所需路径不应与“读取配置正文 / 枚举静态能力资产”混为一谈。

如果要关闭整个来源，应使用 `AGENT_LENS_ENABLED_SOURCES`，而不是把四类内容档位全部设为 `off`。

## 7. 环境信息

环境策略默认 `off`。当前 1.0 不因为 `AGENT_LENS_ENV_CAPTURE=full` 就主动遍历 `process.env`；该档位只是建立统一策略边界，后续任何确有必要的环境采集必须显式调用 `ctx.capturePolicy`，不能自行读取后落库。

因此本次 P0 **没有新增环境变量采集面**。

## 8. Source 的职责

Source 仍可以进行来源特有的防御性清洗，例如解析某种原生数据库时避免把明显凭据放入中间结构。但最终持久化安全性不能依赖 Source 自己“记得脱敏”。

正式规则：

```text
Source-specific sanitation = 防御加固
CapturePolicy             = 来源启用 + 统一持久化门禁
```

第三方 Source 只依赖 Core Contract；不需要、也不应该直接依赖 `@agent-lens/capture-policy`。

## 9. 生效时机与历史数据

采集策略是**新采集 / 新写入数据的策略**，不是历史数据清理器。修改环境变量后需要重启 AgentLens Daemon 才会按新配置运行；Hook / Observer 所在 Agent 进程也需要重新继承相关环境变量。

如果数据库里已经存在此前按 `full` / `redacted` 写入的正文，把档位改成 `off` **不会静默改写或删除旧记录**；同理，`config=off` 会阻止新的静态资产扫描，但不会自动删除此前已经入库的资产库存。关闭某个 Source 也不会删除它过去的 Observation、Evidence、Asset 或 Checkpoint。

因此：

```text
CapturePolicy = 控制未来来源采集与写入
Retention/Purge = 控制既有数据清理（本轮不做）
```

## 10. Hub Replication Policy

多机 Hub 的复制边界不复用 Capture Policy 作为“默认允许上传”的快捷方式。

正式顺序：

```text
Native Source
  -> Capture Policy
  -> Local Canonical Store
  -> Replication Policy
  -> Replication Wire DTO
  -> Hub
```

Capture Policy 决定本机拥有什么；Replication Policy 决定其中什么可以离开本机。两者必须满足单调约束：

> Replication 只能进一步收紧本机已经持久化的内容，不能恢复 Capture Policy 已经关闭或脱敏的信息。

Alpha 至少定义三档：

| 档位 | 语义 |
| --- | --- |
| `metadata-only` | 只复制形成 Session、Agent、Tool、Usage、Identity、Evidence 结构所需的最小元数据，不发送 Prompt / Tool 正文 |
| `redacted` | 允许复制正文，但在出站 Wire DTO 上再次执行 Hub 复制脱敏与长度限制 |
| `full` | 允许复制本机已经持久化的普通业务正文；已识别凭据仍强制遮蔽 |

关键规则：

- `metadata-only` 不能因为 Hub 需要 Projection 就回退上传原始 `SourceRecord.payload`；
- `redacted` / `full` 都必须再次执行网络出站安全处理，不能把“本机已存”视为“适合发网”；
- 如果 Capture Policy 已经把某字段设为 `off` 或遮蔽，Replication Policy 不能恢复原文；
- Wire DTO 必须显式区分 `omitted` / `redacted` / 原始为空，避免 Hub 把“未复制”误解释成事实为空；
- Bootstrap Sync 与 Incremental Sync 必须使用同一个 Replication Policy；
- 修改 Replication Policy 不能静默让 Hub 自动获得过去未授权上传的历史正文；如果用户扩大复制范围，需要明确触发 / 同意对应历史 Bootstrap / Reconcile；
- 收紧 Replication Policy 不等于自动删除 Hub 中已存在的更完整历史副本，历史清理 / Tombstone / Purge 必须是独立显式动作。

首次 Pair / 启用 Hub 时，UI / CLI 必须明确展示当前 Replication Policy，不能以“连接 Hub”为由默认把本机已有完整数据库复制出去。

## 11. 当前不做的事情

当前 P0 / Hub 架构阶段不扩展为通用账号权限系统，不修改 Agent 原生数据，也不把远程 Web 登录与 Replication Policy 混在一起。

后续可以在 CLI / Web 上为来源允许列表、四类 Capture 档位和 Hub Replication 档位增加可视化设置，但每个设置必须落回唯一策略服务，不能出现页面一套、CLI 一套、Replication Client 又一套的独立脱敏规则。
