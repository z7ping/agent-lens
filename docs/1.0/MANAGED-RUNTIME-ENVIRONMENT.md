# 系统托管 Runtime 的环境继承规则

状态：1.0 npm / CLI 后台生命周期正式约束

## 1. 问题

交互式终端中的 AgentLens 与系统托管后台进程不是同一个环境：

```text
Shell
  ├─ PATH
  ├─ Node / npm 版本管理器
  ├─ Source 自定义目录
  └─ AgentLens 运行配置

systemd / launchd / Task Scheduler
  └─ 可能没有继承以上 Shell 环境
```

因此，“终端里能找到 Pi/Codex/Claude，后台服务找不到”不能通过硬编码 `/opt/homebrew/bin`、`~/.volta/bin`、用户名目录等单机路径处理。

## 2. 正式原则

后台生命周期必须使用**显式白名单环境继承**：

- 只固化 AgentLens Runtime 和 Source 运行真正需要的非敏感配置；
- Windows Task Scheduler、Linux systemd user service、macOS LaunchAgent 使用同一份语义白名单；
- 不复制完整 `process.env`；
- 不把 API Key、Token、Cookie、Credential 等敏感变量写进 service definition；
- 不针对 Volta、nvm、Homebrew 等工具写固定目录；
- PATH 不足时由通用 executable discovery 负责从用户登录 Shell 恢复工具路径；
- opaque shim 由独立 resolver 解析，不能把某个版本管理器写进 Pi 业务逻辑。

## 3. 环境变量分类

### 3.1 工具发现

典型变量：

```text
PATH
CODEX_BIN
CLAUDE_BIN
PI_BIN
```

用于发现 CLI executable。PATH 是通用基础能力，显式 `*_BIN` 的优先级高于 PATH。

### 3.2 Source 数据目录覆盖

典型变量：

```text
CODEX_HOME
CLAUDE_CODE_HOME
PI_HOME
PI_CODING_AGENT_DIR
PI_CODING_AGENT_SESSION_DIR
HERMES_HOME
OPENCODE_HOME
DSH_HOME
XDG_DATA_HOME
```

如果用户明确设置了这些目录，切换到后台 Runtime 后必须保持同一 Source 视图，不能悄悄回退默认目录。

### 3.3 AgentLens Runtime 配置

典型变量：

```text
AGENT_LENS_PORT
AGENT_LENS_DB_PATH
AGENT_LENS_VAULT_PATH
AGENT_LENS_WEB_ROOT
AGENT_LENS_PROFILE
AGENT_LENS_CAPTURE_POLICY_PATH
AGENT_LENS_ENABLED_SOURCES
AGENT_LENS_PROMPT_CAPTURE
AGENT_LENS_TOOL_CAPTURE
AGENT_LENS_CONFIG_CAPTURE
AGENT_LENS_ENV_CAPTURE
```

这些变量改变 AgentLens 自己的运行语义。用户在执行 `service start` / `autostart enable` 时明确配置了它们，系统托管定义就应保持相同语义。

### 3.4 禁止自动持久化的环境

禁止使用：

```text
Object.entries(process.env)
```

整体写入 systemd / launchd / Task Scheduler。

尤其不能默认持久化：

- API Key；
- Access Token；
- Authorization；
- Cookie；
- Password / Secret / Credential；
- 与 AgentLens 生命周期无关的第三方应用环境。

需要新增环境变量时，应先判断它是否属于 Runtime / Source 的正式配置契约，再加入统一白名单。

## 4. executable discovery

通用发现顺序：

```text
显式 executable
→ 对应 *_BIN
→ 当前 PATH
→ 当前 Node 所在目录
→ POSIX 用户登录 Shell PATH
→ 未找到
```

找到 executable 后，如果路径是普通文件或 symlink，先走真实路径与包定位；只有遇到 opaque shim 时才进入 shim resolver。

当前 shim resolver 作为可扩展适配层支持：

```text
Volta
mise
asdf
```

Pi Runtime 只消费最终 executable target，不感知具体版本管理器。

## 5. 生命周期真值

“定义文件写入成功”不等于“后台服务成功”。正式状态至少分为：

```text
registered   系统定义存在
loadable     系统服务管理器能解析定义
active       系统认为进程正在运行
autostart    登录自启真实启用
runtime      AgentLens Health 可达且协议兼容
owner        Runtime Owner 与期望一致
```

`service start/restart` 只有在系统托管状态和 AgentLens Runtime 真值一致时才能返回成功。

如果默认端口已经存在不兼容服务，AgentLens 必须拒绝抢占，而不是换端口或进入系统服务重启循环。

## 6. 新 Source / 新平台接入检查

新增 Source 或生命周期平台时必须先回答：

1. 是否需要 executable discovery？
2. 是否已有通用 resolver 可以复用？
3. 是否有需要跨后台生命周期保留的非敏感配置？
4. 是否把环境差异误写成某个用户、某台机器或某种安装器的特判？
5. 系统状态和 AgentLens Health 是否分别验证？

不满足以上条件时，不应以“当前机器能运行”作为正式实现完成标准。
