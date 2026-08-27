# 安全策略

AgentLens 会读取本地 AI 编码 Agent 暴露的 Session、Tool 调用、结果、配置路径和能力资产。这些数据可能包含源代码、提示词、文件路径、访问令牌或其他敏感信息。

## 1.0 当前安全边界

- HTTP Surface 固定监听 `127.0.0.1`，默认端口 `56789`。
- 当前 `/api/v1/*` 是本机只读 GET Surface；1.0 **没有网络认证层**，安全边界依赖 loopback。不要通过反向代理、端口转发或其他方式把它暴露到不可信网络。
- 静态文件只从配置的 Web 构建目录读取，并通过真实目录边界检查阻止路径逃逸。
- Codex / Claude Hook 与 Hermes Observer 只做被动采集、敏感字段清洗和 Durable Inbox 原子写入，不执行 AgentLens Core / SQLite / HTTP 逻辑。
- 正式 Daemon 强制加载 `@agent-lens/capture-policy`；SourceRecord、Canonical Observation 和静态资产在持久化前统一经过隐私策略。
- 默认只允许采集 Claude Code；Codex、Pi、Hermes、OpenCode 等需要显式加入 `AGENT_LENS_ENABLED_SOURCES`。
- 默认数据目录 `~/.agent-lens/1.0/` 中的 SQLite、Inbox，以及未来 Hub Replication State，都应视为敏感本机数据。
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

详细规则的唯一权威来源：`docs/1.0/CAPTURE-POLICY.md`。

## Hub 多机复制安全边界

Hub Alpha 仍保持 Local-first：

```text
Local Web / API
 -> 127.0.0.1:56789

Node
 -> outbound authenticated HTTPS
 -> Hub Replication Surface
```

仓库总安全边界只强调：

- 不得为了 Hub 把 Local Surface 改为 `0.0.0.0`；
- Node 只主动连接 Hub，Hub 不反向访问 / 控制 Node；
- Capture Policy 与 Replication Policy 分离，本机允许保存不代表允许出站；
- `metadata-only` 不是匿名模式；
- Pairing Secret、Node Key、Hub Identity、TLS Identity 各自职责分离；
- 未配对、已撤销、身份或签名校验失败时不得写入 Hub；
- Hub 汇聚多机数据后安全半径高于单 Node；
- Alpha 不提供 Remote Web Login、Remote Execution 或 Remote Attestation。

Hub 的密码学、配对、Clone Detection、数据出站范围、重放保护、资源滥用限制与 trusted-node 真实性边界，统一以：

`docs/1.0/HUB-PAIRING-SECURITY.md`

为专项权威来源；Wire 兼容语义见 `docs/1.0/HUB-REPLICATION-PROTOCOL.md`，系统设计见 `docs/1.0/HUB-DESIGN.md`。

不要在本文件再次复制完整 Hub Policy 字段矩阵、协议错误码或握手字段。

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
- 已撤销 Node 仍可上传；
- `metadata-only` 上传本应禁止的 Prompt / Tool 正文或完整本机路径；
- Replication 恢复 Capture Policy 已经禁止的信息；
- Hub Control Plane 可反向执行 Node 系统命令；
- 超大 Batch 可导致 Hub OOM；
- Hub Identity 变化却因 endpoint 相同被静默信任；
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
