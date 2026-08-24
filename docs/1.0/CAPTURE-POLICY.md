# AgentLens 1.0 采集隐私策略

更新日期：2026-08-24  
状态：1.0 P0 稳定化基线

AgentLens 通过独立的 `@agent-lens/capture-policy` 插件统一控制持久化边界上的隐私行为。该插件是独立实现，但在官方 Daemon 中属于**强制基础插件**：Source 不能绕过它直接把原始正文写入 1.0 数据库。

## 1. 为什么是独立插件

Source 负责回答“来源暴露了什么、如何解析”；采集隐私策略负责回答“哪些内容允许持久化”。两者必须分离：

```text
Source
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

`@agent-lens/core` 只声明 `CapturePolicyService` 契约，不依赖 Cordis。`@agent-lens/capture-policy` 实现该契约，并由 Cordis Runtime 以 `ctx.capturePolicy` 提供给通用 Source Runner。各 Source 不直接依赖隐私插件实现。

## 2. 四类采集范围

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

## 3. 三个档位的语义

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

## 4. SourceRecord 的处理顺序

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

## 5. 配置关闭的边界

`AGENT_LENS_CONFIG_CAPTURE=off` 会阻止 Source Runner 调用静态 `discoverAssets()`，因此不会新建 Skill / MCP / Plugin / Extension / Hook 等静态资产盘点结果。

它**不会**关闭 Source Detection、History 或 Runtime Capture；AgentLens 仍需要最小安装/数据根信息来定位原生数据源并保持 Installation 身份稳定。这些运行所需路径不应与“读取配置正文 / 枚举静态能力资产”混为一谈。

## 6. 环境信息

环境策略默认 `off`。当前 1.0 不因为 `AGENT_LENS_ENV_CAPTURE=full` 就主动遍历 `process.env`；该档位只是建立统一策略边界，后续任何确有必要的环境采集必须显式调用 `ctx.capturePolicy`，不能自行读取后落库。

因此本次 P0 **没有新增环境变量采集面**。

## 7. Source 的职责

Source 仍可以进行来源特有的防御性清洗，例如解析某种原生数据库时避免把明显凭据放入中间结构。但最终持久化安全性不能依赖 Source 自己“记得脱敏”。

正式规则：

```text
Source-specific sanitation = 防御加固
CapturePolicy             = 统一持久化门禁
```

第三方 Source 只依赖 Core Contract；不需要、也不应该直接依赖 `@agent-lens/capture-policy`。

## 8. 生效时机与历史数据

采集策略是**新写入数据的持久化策略**，不是历史数据清理器。修改环境变量后需要重启 AgentLens Daemon 才会按新档位运行。

如果数据库里已经存在此前按 `full` / `redacted` 写入的正文，把档位改成 `off` **不会静默改写或删除旧记录**；同理，`config=off` 会阻止新的静态资产扫描，但不会自动删除此前已经入库的资产库存。历史清理属于独立的数据保留 / 清理动作，必须显式执行，不能在策略切换时隐式破坏用户历史。

因此：

```text
CapturePolicy = 控制未来写入
Retention/Purge = 控制既有数据清理（本轮不做）
```

## 9. 当前不做的事情

本轮 P0 不扩展为新的设置中心，也不增加远程认证层，不修改 Agent 原生数据。后续可以在 CLI / Web 上为这四个档位增加可视化设置，但任何设置入口最终都只能修改同一个 `CapturePolicyService` 策略，不能再出现第二套脱敏实现。
