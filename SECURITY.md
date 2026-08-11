# 安全策略

AgentLens 会读取本地 Agent 会话、工具参数、输出摘要、配置路径和能力资产。这些数据可能包含源代码、提示词、文件路径、访问令牌或其他敏感信息。

## 默认安全边界

- HTTP 服务只监听 `127.0.0.1`，当前不支持局域网或公网访问。
- API 拒绝非回环 Host、远程连接和未允许的浏览器 Origin，不返回通配 CORS。
- `/api/hook` 只接受 JSON，并要求 `X-AgentLens-Token` 或 Bearer 令牌。令牌保存在运行目录 `run/hook-token`，不得提交或分享。
- 提示词、工具数据和配置默认使用 `redacted` 档位；环境信息默认 `off`，启用后也只读取允许名单。
- 凭据字段、Authorization、Cookie、常见 Token 和 URL 敏感参数会在写入 Timeline 与 JSONL 前脱敏。
- v0.4 之前的历史正文不会在迁移中静默改写，其采集策略标记为未知。分享旧数据库前仍需人工检查。

自定义本机开发前端如需直连 API，可用 `AGENT_LENS_ALLOWED_ORIGINS` 显式增加 `http://localhost:<端口>` 或 `http://127.0.0.1:<端口>`；非回环来源会被忽略。仓库自带 Vite 开发代理无需放宽该名单。

采集档位可通过 `AGENT_LENS_PROMPT_CAPTURE`、`AGENT_LENS_TOOL_CAPTURE`、`AGENT_LENS_CONFIG_CAPTURE` 和 `AGENT_LENS_ENV_CAPTURE` 调整，取值为 `off`、`redacted` 或 `full`。启用 `full` 意味着相应原文会进入本机持久化存储。

`AGENT_LENS_CONFIG_CAPTURE=off` 会停止配置盘点，并在下一次概览刷新时清除已缓存的配置路径与静态能力资产；查询接口会立即隐藏旧缓存。环境采集保持关闭时不会读取环境内容。

## 报告安全问题

请不要通过公开 GitHub Issue 报告以下问题：

- API Key、Token、密码或环境变量泄露。
- 提示词、会话、源代码或本机路径被未授权访问。
- HTTP 服务能够被非预期网络访问。
- 路径遍历、任意文件读取或写入。
- Hook、MCP、插件或导入器导致的命令执行问题。
- 脱敏逻辑失效。

请使用以下任一私密渠道：

1. [GitHub 私密安全报告](https://github.com/z7ping/agent-lens/security/advisories/new)。
2. 邮件发送至 `z7ping@outlook.com`，标题以 `[AgentLens Security]` 开头。

报告中请包含：

- 受影响版本和平台。
- 最小复现步骤。
- 实际影响和可利用条件。
- 已知缓解方法。
- 必要的脱敏日志；不要发送真实凭据。

## 处理原则

- 收到报告后优先确认影响范围和临时缓解措施。
- 修复发布前不公开可直接利用的细节。
- 发布修复后在 CHANGELOG 和安全公告中说明受影响版本与升级建议。
- 未经报告者同意，不公开其身份信息。

## 用户侧建议

- 只在可信机器和可信项目中运行 AgentLens。
- 不要将运行时 `.agent-lens/` 目录提交到版本控制。
- 不要把服务端口暴露到公网或不受信任的局域网。
- 不要绕过回环监听、Origin 校验或 Hook 令牌保护。
- 分享截图、数据库或日志前先检查提示词、代码、路径和凭据。
- MCP 健康检查和外部命令只应在确认配置可信后手动执行。
