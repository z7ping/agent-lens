# 安全策略

AgentLens 会读取本地 AI 编码 Agent 暴露的 Session、Tool 调用、结果、配置路径和能力资产。这些数据可能包含源代码、提示词、文件路径、访问令牌或其他敏感信息。

## 1.0 当前安全边界

- HTTP Surface 固定监听 `127.0.0.1`，默认端口 `56789`。
- 当前 `/api/v1/*` 是本机只读 GET Surface；1.0 **没有网络认证层**，安全边界依赖 loopback 监听。不要通过反向代理、端口转发或其他方式把它暴露到不可信网络。
- 静态文件只从配置的 Web 构建目录读取，并通过真实目录边界检查阻止路径逃逸。
- Codex / Claude Hook 与 Hermes Observer 只做被动采集、敏感字段清洗和 Durable Inbox 原子写入，不应执行 AgentLens Core / SQLite / HTTP 逻辑。
- 正式 Daemon 强制加载 `@agent-lens/capture-policy`，来源允许列表在 Detect / History / Runtime / Asset 之前生效；启用来源的 SourceRecord、Canonical Observation 和静态资产在持久化前继续统一经过采集隐私策略。各 Source 自己的清洗只作为防御加固，不能替代统一门禁。
- 默认只允许采集 Claude Code；Codex、Pi、Hermes、OpenCode 等来源需要显式加入 `AGENT_LENS_ENABLED_SOURCES`。
- 默认数据目录是 `~/.agent-lens/1.0/`，其中的 SQLite 数据库和 Inbox 都应视为敏感本机数据。
- Source 原生日志本身可能包含 Prompt、Tool 参数、Tool Result 或路径信息。即使 Hook 路径会清洗常见敏感字段，也不要假设所有来源数据天然适合公开分享。
- AgentLens 不声称获取来源未暴露的隐藏思维链。

## 来源采集开关

AgentLens 1.0 使用完整来源允许列表控制哪些 Source 可以进入采集流程：

```text
AGENT_LENS_ENABLED_SOURCES=claude-code
```

默认只启用 `claude-code`。需要同时启用多个来源时使用逗号分隔：

```text
AGENT_LENS_ENABLED_SOURCES=claude-code,codex,pi,hermes,opencode
```

显式关闭全部来源：

```text
AGENT_LENS_ENABLED_SOURCES=none
```

禁用来源必须在 `detect()` 之前被过滤，并且不能进入 History、Runtime Capture、Asset Discovery。Codex / Claude Hook 与 Hermes Observer 也必须遵守同一允许列表，禁用时不得继续向 Durable Inbox 写入新事件。

修改来源允许列表后需要重启 AgentLens Daemon；Hook / Observer 还需要对应 Agent 进程重新继承环境变量。关闭来源不会自动删除此前已经持久化的数据库、Inbox、Observation、Evidence 或 Asset 数据。

## 采集隐私档位

AgentLens 1.0 支持四类独立采集策略：

```text
AGENT_LENS_PROMPT_CAPTURE=redacted
AGENT_LENS_TOOL_CAPTURE=redacted
AGENT_LENS_CONFIG_CAPTURE=redacted
AGENT_LENS_ENV_CAPTURE=off
```

每项可设为 `off`、`redacted` 或 `full`。其中 `off` 不持久化正文但尽量保留任务轨迹所需的最小结构事实；`redacted` 执行统一脱敏；`full` 保留普通正文，但 Token、API Key、Password、Authorization、Cookie 等明确凭据仍会被强制遮蔽。

`AGENT_LENS_CONFIG_CAPTURE=off` 会跳过静态资产发现；它不会破坏已启用 Source 的 Detection / History / Runtime 所需的最小安装和数据根定位。`AGENT_LENS_ENV_CAPTURE` 默认关闭，当前 1.0 也不会因为用户打开该档位就主动遍历并新增环境变量采集。

来源允许列表与四类内容档位是正交关系：先决定某个 Source 是否允许采集，再对该 Source 的 Prompt / Tool / Config / Environment 内容应用对应档位。

详细规则见 `docs/1.0/CAPTURE-POLICY.md`。策略在 Daemon 启动时读取，修改后需要重启。策略只控制后续采集 / 写入，不会静默清理此前已持久化的正文或资产；历史清理必须通过显式的数据保留 / 清理操作完成。

## 本机数据

典型目录：

```text
~/.agent-lens/1.0/
├── agent-lens.db
└── inbox/
    ├── claude-code/
    ├── codex/
    └── hermes/
```

请不要：

- 把该目录提交到 Git；
- 把数据库、Inbox、真实 Session JSONL 或 Hook 输入直接上传到 Issue；
- 在截图或日志中暴露 API Key、Token、Cookie、Authorization、源代码或本机路径；
- 将 `127.0.0.1:56789` 通过代理或端口映射暴露到公网 / 不可信局域网。

## Hook 配置

`agent-lens hook install` / `uninstall` 只应修改 AgentLens 自己管理的 Handler，并保留同一配置中的第三方 Handler。

如果发现以下行为，请按安全问题处理：

- 安装 / 卸载覆盖或删除第三方 Hook；
- Hook 可以被非预期输入诱导执行任意命令；
- Durable Inbox 写入发生路径逃逸；
- 禁用来源仍执行 Detect / History / Runtime / Asset 或继续写 Durable Inbox；
- 敏感字段清洗明显失效；
- 采集隐私档位可以被 Source 绕过并把关闭/脱敏范围的原始正文写入 SQLite；
- Daemon 可以从非 loopback 网络访问；
- 静态资源存在路径遍历或任意文件读取；
- 数据库 / Session / Prompt 被未授权进程或网络接口暴露。

## 报告安全问题

请不要通过公开 GitHub Issue 报告可利用的安全漏洞。

可使用：

1. [GitHub 私密安全报告](https://github.com/z7ping/agent-lens/security/advisories/new)
2. 邮件：`z7ping@outlook.com`，标题以 `[AgentLens Security]` 开头

报告中建议包含：

- 受影响版本和平台；
- 最小复现步骤；
- 实际影响和可利用条件；
- 已知缓解方法；
- 必要的脱敏日志，禁止发送真实凭据。

## 处理原则

- 优先确认影响范围和临时缓解措施；
- 修复发布前不公开可直接利用的细节；
- 修复发布后在 CHANGELOG / Security Advisory 中说明受影响版本和升级建议；
- 未经报告者同意，不公开其身份信息。
