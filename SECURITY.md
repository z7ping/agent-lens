# 安全策略

AgentLens 会读取本地 AI 编码 Agent 暴露的 Session、Tool 调用、结果、配置路径和能力资产。这些数据可能包含源代码、提示词、文件路径、访问令牌或其他敏感信息。

## 1.0 当前安全边界

- HTTP Surface 固定监听 `127.0.0.1`，默认端口 `56789`。
- 当前 `/api/v1/*` 是本机只读 GET Surface；1.0 **没有网络认证层**，安全边界依赖 loopback。不要通过反向代理、端口转发或其他方式把它暴露到不可信网络。
- 静态文件只从配置的 Web 构建目录读取，并通过真实目录边界检查阻止路径逃逸。
- Codex / Claude Hook 与 Hermes Observer 只做被动采集、敏感字段清洗和 Durable Inbox 原子写入，不执行 AgentLens Core / SQLite / HTTP 逻辑。
- 正式 Daemon 强制加载 `@agent-lens/capture-policy`；SourceRecord、Canonical Observation 和静态资产在持久化前统一经过隐私策略。
- 默认只允许采集 Claude Code；Codex、Pi、Hermes、OpenCode 等需要显式加入 `AGENT_LENS_ENABLED_SOURCES`。
- 默认数据目录 `~/.agent-lens/1.0/` 中的 SQLite、Inbox，以及未来 Hub Replication Control Plane 都应视为敏感本机数据。
- Source 原生日志本身可能包含 Prompt、Tool 参数、Result 或路径，不要假设来源数据天然适合公开分享。
- AgentLens 不声称获取来源未暴露的隐藏思维链。

## 来源采集开关

默认：

```text
AGENT_LENS_ENABLED_SOURCES=claude-code
```

多来源：

```text
AGENT_LENS_ENABLED_SOURCES=claude-code,codex,pi,hermes,opencode
```

关闭全部：

```text
AGENT_LENS_ENABLED_SOURCES=none
```

禁用来源必须在 `detect()` 之前过滤，也不能进入 History、Runtime、Asset Discovery。Codex / Claude Hook 与 Hermes Observer 也必须遵守同一允许列表。

修改后需要重启 Daemon；Hook / Observer 还需对应 Agent 进程重新继承环境变量。关闭来源不会自动删除旧数据。

## 采集隐私档位

```text
AGENT_LENS_PROMPT_CAPTURE=redacted
AGENT_LENS_TOOL_CAPTURE=redacted
AGENT_LENS_CONFIG_CAPTURE=redacted
AGENT_LENS_ENV_CAPTURE=off
```

每项可设 `off | redacted | full`。

- `off`：不持久化对应正文，但尽量保留结构事实；
- `redacted`：统一脱敏；
- `full`：保留普通正文，但 Token、API Key、Password、Authorization、Cookie 等明确凭据仍强制遮蔽。

详细规则见 `docs/1.0/CAPTURE-POLICY.md`。

## Hub 多机复制安全边界

ADR-0007 规定 Hub 继续 Local-first，并且 **Replication Surface 与 Local HTTP Surface 完全分离**。

```text
Node
  -> outbound HTTPS
  -> Hub Replication Surface

Local Web / API
  -> 127.0.0.1:56789
```

关键规则：

- 不得为了 Hub 把 `127.0.0.1:56789` 改为 `0.0.0.0`；
- Node 只主动向 Hub 建立出站连接，Hub 不反向访问 Node；
- Alpha 不内建 Remote Web Login；
- Pairing 使用短期一次性 Secret，成功后失效；
- Node 长期身份使用非对称密钥，Private Key 不上传 Hub；
- Hub Replication Surface 必须 TLS；自管理 TLS 使用 SPKI Pin；
- Hub Identity 与 TLS Identity 分离；Hub Identity 必须签名 Pairing Receipt 与 Handshake `serverProof`，不能只是装饰字段；
- Pairing Request 必须证明 Node 持有提交的 Public Key；
- 长期 Request Signature 必须绑定 `hubId / nodeId / replicationStreamId / keyId / method / path / timestamp / nonce / raw-body-hash`；
- 未配对、已撤销、Hub Proof 错误或 Node Signature 验证失败时不得上传；
- Alpha 单 Hub 星型拓扑，一个 Node 最多一个 upstream Hub，不支持 Federation / 级联。

专项定义见：

- `docs/1.0/HUB-PAIRING-SECURITY.md`；
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`；
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`。

## Node Identity 与 Clone Detection

`nodeId` 表示 AgentLens 数据根 / 实例的持久身份，不等同 hostname。

复制整个 `~/.agent-lens/1.0/` 可能同时复制 nodeId 与 Private Key。

Clone Detection 必须区分强 / 弱信号：

### 强冲突信号

- 同一 nodeId / stream 出现真实并发 runtime instances；
- sequence / immutable Batch 出现不可解释分叉；
- 两个实例竞争同一个 active Stream 并产生互斥状态。

达到强冲突才冻结 Stream，并要求显式处理。

### 弱信号

- IP 变化；
- hostname / platform metadata 变化；
- sleep / wake 后短暂旧连接；
- 网络接口变化。

弱信号只能进入 Diagnostics，不能单独触发 `IDENTITY_NODE_CONFLICT`，避免笔记本换网 / 改名误报。

Node Identity Reset / Re-pair 必须显式执行。

## Capture Policy、Replication Policy、History Scope

“允许写入本机数据库”不等于“允许上传 Hub”。

```text
Native Source
  -> Capture Policy
  -> Local Canonical Store
  -> Replication Policy
  -> History Scope
  -> Hub
```

严格说，Policy 与 History Scope 是两个正交维度：

- Replication Policy：允许出站哪些字段；
- History Scope：是否允许补传建立边界前已存在的历史事实。

Replication Policy 至少：

```text
metadata-only
redacted
full
```

History Scope 至少：

```text
from-now
include-existing
```

### `metadata-only` 不是匿名模式

它不上传 Prompt / Tool 正文，并默认不上传完整 Workspace 本机路径；但仍可能上传：

- 会话结构；
- Agent / Tool 名称；
- 时间与使用模式；
- 用于项目聚合的规范化 Repository Identity。

因此 UI 不得声称“仅元数据不会上传任何敏感信息”。

详细字段边界见 `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`。

### Policy 收紧

`full -> metadata-only` 保存后必须立即停止新的 full 出站请求。

如果存在“可能已到 Hub、ACK 丢失”的旧 full Batch，不能为了补 sequence gap 继续发送用户刚禁止的正文；应安全暂停旧 Stream，并按 State Contract 执行 Stream Rollover / Reconciliation。

已经在 Hub 的旧完整数据不会自动删除，需要独立 Purge。

### Policy 放宽

`metadata-only -> full` 不能自动补旧历史；需要用户明确选择“仅未来”或“补传已有历史”。

## Hub 数据落盘风险

Hub 可能汇聚多台机器的：

- Session / Prompt / Tool 数据；
- 项目 / 仓库身份；
- 路径；
- 资产信息。

因此 Hub 数据安全半径高于单 Node。

Alpha：

- 数据根仅当前 OS 用户可访问；
- 不宣称 SQLite 提供内建透明加密；
- 使用 `full` 时建议受保护账户 / 系统磁盘加密；
- 不自动上传 Hub DB 到云服务；
- 普通 Asset Backup 不包含 Node / Hub / TLS Private Key；
- Canonical Replica 与 Hub Identity / Pairing Control Plane 的恢复是不同问题。

## Hub 资源滥用保护

已配对 Node 也不能获得无限资源预算。

Replication Surface 至少限制：

```text
HTTP body bytes
single entity bytes
entities per batch
per-node rate
concurrency
Hub storage low-water
```

稳定错误语义至少包括：

```text
BATCH_TOO_LARGE
ENTITY_TOO_LARGE
SERVER_BUSY
SERVER_STORAGE_PRESSURE
```

资源压力只能让 Replication degraded / paused，不能阻塞 Node 本机 Canonical Pipeline。

## Headless Hub

Alpha 不提供内建 Remote Web 认证。

Pure Hub 跑在 Linux / NAS 时，可以使用：

- SSH 后执行本机 CLI；
- OS 远程会话；
- 用户自己建立可信 tunnel 访问 loopback Web。

这不改变 AgentLens 自己的 Local Web 安全边界。

## 本机数据

典型目录：

```text
~/.agent-lens/1.0/
├── agent-lens.db
├── inbox/
└── security/        # Hub / Node capability 实现后
```

请不要：

- 把该目录提交 Git；
- 把数据库、Inbox、真实 Session / Hook 输入直接上传 Issue；
- 在截图 / 日志中暴露 API Key、Token、Cookie、Authorization、源代码或本机路径；
- 将 `127.0.0.1:56789` 映射到公网 / 不可信局域网；
- 把 Hub DB / Raw Replication Body 当普通日志分享。

## Hook 配置

`agent-lens hook install / uninstall` 只修改 AgentLens 自己管理的 Handler，并保留第三方 Handler。

以下行为按安全问题处理：

- 安装 / 卸载破坏第三方 Hook；
- Hook 被非预期输入诱导执行任意命令；
- Durable Inbox 路径逃逸；
- 禁用来源仍采集 / 写 Inbox；
- Capture Policy 被 Source 绕过；
- Local HTTP Surface 可从非 loopback 直接访问；
- Hub Replication Surface 未经 TLS / Pair / Node Auth 即可写入；
- Pairing Request 不证明 Node Key Possession；
- Hub Identity Proof 不验证仍继续上传；
- 修改 Node / Stream / Hub Header 后 Signature 仍有效；
- `metadata-only` 上传 Prompt / Tool 正文或完整 Workspace 路径；
- Replication 恢复 Capture 已经禁止的信息；
- 已撤销 Node 仍可上传；
- Clone Detection 仅因 IP / hostname 变化冻结合法设备；
- Hub Control Plane 可反向执行 Node 系统命令；
- 超大 Batch 可导致 Hub OOM；
- Hub Identity 丢失后仅因 endpoint 相同被静默信任；
- 静态资源存在路径遍历 / 任意文件读取；
- 数据库 / Session / Prompt 被未授权进程或网络接口暴露。

## 报告安全问题

请不要通过公开 GitHub Issue 报告可利用漏洞。

可使用：

1. [GitHub 私密安全报告](https://github.com/z7ping/agent-lens/security/advisories/new)
2. 邮件：`z7ping@outlook.com`，标题以 `[AgentLens Security]` 开头

建议包含：

- 受影响版本 / 平台；
- 最小复现；
- 实际影响；
- 已知缓解；
- 必要脱敏日志，禁止真实凭据。

## 处理原则

- 优先确认影响范围和临时缓解；
- 修复发布前不公开可直接利用细节；
- 修复后在 CHANGELOG / Security Advisory 说明影响版本与升级建议；
- 未经报告者同意，不公开其身份。
