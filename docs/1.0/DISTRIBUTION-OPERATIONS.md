# AgentLens 1.0 双发行运维与共存规则

更新日期：2026-08-29  
状态：1.0 稳定化实现基线

本文记录 npm / CLI 与 Windows Desktop 同时作为一等发行方式时的实际运维规则。

## 1. 总原则

AgentLens 不是两套产品，而是：

```text
npm / CLI ───────┐
                 ├─ 同一个 AgentLens Daemon
Windows Desktop ─┘
                        ↓
               ~/.agent-lens/1.0
```

必须保持：

- 同一套 Core / Cordis Runtime / Protocol；
- 同一默认数据根；
- 同一默认端口 `127.0.0.1:56789`；
- 同一套 Canonical Observation / Evidence；
- 同一套 Hook Durable Inbox；
- 同一时刻一个有效 Daemon。

发行方式只决定“谁负责启动 / 停止 / 恢复”，不能制造第二套事实链。

## 2. npm 正式使用方式

首次初始化：

```bash
npm install -g @z7ping/agent-lens
agent-lens setup
```

前台调试：

```bash
agent-lens start
```

后台常驻：

```bash
agent-lens service start
agent-lens service status
agent-lens service restart
agent-lens service stop
```

登录自启：

```bash
agent-lens autostart enable
agent-lens autostart status
agent-lens autostart disable
```

诊断：

```bash
agent-lens status
agent-lens doctor
```

后台托管映射：

```text
Windows -> 当前用户 Task Scheduler
Linux   -> systemd --user
macOS   -> LaunchAgent / launchd
```

不维护 PID 文件，不恢复 0.x Service Manager。

## 3. Windows Desktop 使用方式

Desktop：

- Windows 交互安装完成后默认启动 AgentLens，并立即显示启动窗口；只有明确带 `--hidden` 的登录自启才从托盘静默进入；
- 登录 Windows 后可自动进入托盘；
- 启动前探测已有兼容 Daemon；
- 探测使用短重试窗口，避免高负载时把“响应稍慢”误判成“没有 Daemon”而启动第二套运行时；
- npm Daemon 已存在时直接复用；
- 只有没有兼容 Daemon 时才启动自己拥有的 Daemon；
- 等待 Daemon 就绪时仍校验 Protocol 版本，不把不兼容运行时误判为启动成功；
- 首次 History / Asset 同步较慢时保持启动窗口和 Daemon 运行，不因短 Health 超时提前杀死有效进程；并发 Health 请求复用同一个 Storage 探测，避免轮询放大 SQLite 队列；
- 退出时只停止自己拥有的 Daemon；
- 启动后登记自身为可用 Hook Provider；
- 只对本机实际检测到的 Codex / Claude Code 修复 AgentLens Hook；
- Pi 不安装 Hook。

Desktop 的 Hook 文件在正式安装包中解包到外部进程可访问路径，避免 PowerShell / Electron-as-Node 无法直接读取 `app.asar` 内部 Hook 文件。

### 3.1 Desktop CLI 与 npm CLI

Windows Desktop 作为一等发行方式，必须在**没有可用 1.x npm CLI**时独立提供：

```powershell
agent-lens -h
agent-lens status
agent-lens doctor
```

Desktop 不会为了获得 CLI 自动执行：

```bash
npm install -g @z7ping/agent-lens
```

也不会要求用户为了安装 Desktop 预先安装 Node.js / npm。Desktop 安装包本身已经包含同一份 `runtime/cli.mjs`，因此只需要提供一个薄 `agent-lens.cmd` shim：

```text
agent-lens.cmd
  -> AgentLens.exe + ELECTRON_RUN_AS_NODE=1
  -> resources/app.asar.unpacked/runtime/cli.mjs
  -> 同一套 CLI / Runtime / ~/.agent-lens/1.0
```

CLI 所有权与 Runtime 所有权必须分开判断：

```text
CLI 所有权
  -> 看本机是否存在有效的 1.x npm AgentLens

Runtime 所有权
  -> 看 127.0.0.1:56789 是否已有兼容 Daemon，以及谁启动了它
```

Windows PATH 采用确定性规则，而不是依赖偶然顺序：

1. 检测 `npm prefix -g`；
2. 只有同时存在全局 `@z7ping/agent-lens/package.json`、`agent-lens.cmd`，且版本主版本号 `>= 1`，才视为有效 npm CLI；
3. 有效 1.x npm CLI 存在时：npm 全局目录排在 Desktop 安装目录之前，npm CLI 是主入口；Desktop CLI 仍保留在后方作为 npm 被卸载后的兜底；
4. 没有有效 1.x npm CLI，或只存在 0.x npm CLI 时：Desktop 安装目录排在前方，避免旧 0.x CLI 重新获得 1.x 默认命令所有权；
5. Desktop 每次启动都会重新执行同一套 PATH 协调逻辑，因此用户后续安装 1.x npm 包后，下一次启动 Desktop 会自动把 npm CLI 调整为主入口；
6. npm AgentLens 后续被卸载时，不需要重新安装 Desktop：npm wrapper 消失后，PATH 中后置的 Desktop shim 自动接替；
7. 卸载 Desktop 时只移除 Desktop 自己的 PATH 项，不删除 npm 全局目录、npm 包或 npm wrapper。

实现约束：

- 不使用 `setx`，避免长 PATH 被截断；
- 不覆盖整个用户 PATH；
- 不静默安装、卸载或修改全局 npm 包；
- 覆盖升级时先移除旧 Desktop PATH，再按当前 npm/Desktop 状态重新排序；
- 修改 PATH 后，已经打开的 PowerShell / CMD 不会自动刷新自身环境，用户应重新打开终端再验证。

Windows Desktop 的 Electron bootstrap 与 Daemon 日志必须使用同一目录。打包版优先写入 `<安装目录>\logs`，可通过 `AGENT_LENS_LOG_DIR` 显式覆盖；安装目录不可写时才回退 `%APPDATA%\AgentLens\logs`。不得再由 npm 包名派生出另一套日志目录。

Windows 登录自启以系统真实状态为准：

- 首次默认启用后会再次读取 Windows 登录项状态；
- 只有确认启用后才写入“一次性初始化完成”标记；
- 托盘切换自启后也会再次读取系统状态；
- 如果 Windows 未接受修改，托盘勾选恢复为系统真实状态，并给出明确提示。

## 4. 安装登记

共享安装登记目录：

```text
~/.agent-lens/1.0/installations/
├── npm.json
└── desktop.json
```

登记字段包括：

```text
schemaVersion
kind
version
executable
hookRoot
electronRunAsNode
registeredAt
updatedAt
```

登记文件是“候选 Provider 记录”，不是安装事实。

每次使用前必须验证：

1. executable 存在；
2. hookRoot 存在；
3. `agent-lens-hook-codex.mjs` 存在；
4. `agent-lens-hook-claude.mjs` 存在。

只要真实文件已经消失，该登记立即视为无效。无需依赖卸载回调删除 JSON。

这是为了兼容 npm 7+ 没有 package uninstall lifecycle 的现实行为，也避免客户端被直接卸载后残留登记影响 npm。

## 5. Windows 共享 Hook 分发器

Windows Native Hook 不直接指向 npm 安装路径，也不直接指向 Desktop 安装路径。

稳定配置目标为：

```text
~/.agent-lens/1.0/runtime/windows-hook-dispatcher.ps1
```

调用链：

```text
Codex / Claude Code
        ↓
共享 Hook 分发器
        ↓
读取 desktop.json / npm.json
        ↓
检查真实文件
        ↓
Desktop 有效 -> Desktop Hook
否则 npm 有效 -> npm Hook
否则 -> 中性退出
        ↓
Durable Inbox
```

共享分发器使用 `CreateNoWindow`，并继承原生 stdin / stdout，不能改写上游 Hook 的数据语义。

## 6. 卸载与自愈

### 6.1 npm + Desktop 都存在，卸载 npm

```text
npm agent-lens.cmd / package 消失
  ↓
PATH 中 Desktop shim 仍存在
  ↓
agent-lens 命令自动回退 Desktop
  ↓
npm.json 可能仍存在，但共享分发器验证 hookRoot 失败
  ↓
跳过 npm Provider
  ↓
继续使用 Desktop
```

不要求 npm uninstall 回调，也不要求重新安装 Desktop。

### 6.2 npm + Desktop 都存在，卸载 Desktop

```text
AgentLens.exe / Desktop HookRoot 消失
  ↓
Desktop 安装目录从用户 PATH 移除
  ↓
npm 全局目录与 npm agent-lens.cmd 保持不变
  ↓
desktop.json 即使残留也因真实文件验证失败而失效
  ↓
共享分发器继续使用 npm Provider
```

不需要重写 Codex / Claude Hook 配置，也不得删除 npm 全局命令或 npm PATH。

### 6.3 两种发行都不存在

共享分发器中性退出，不阻断 Codex / Claude Code 自身工作流。

用户数据默认继续保留在：

```text
~/.agent-lens/1.0
```

## 7. 运行时互斥

运行时所有者：

```text
cli      前台命令行
service  npm 系统托管后台
Desktop  Windows 客户端
```

Desktop 和 npm service 都必须在启动 Daemon 前探测现有 `127.0.0.1:56789/api/v1/health`。

已有兼容 Daemon：复用。  
协议不兼容：明确报错。  
禁止通过换端口偷偷启动第二个 1.0 Runtime。

Desktop 的健康探测不是单次 500ms 判定；当前会进行有限重试，以降低 Windows 启动阶段、磁盘繁忙或高负载时的误判概率。即使启动竞争已经发生，Desktop 也必须以 Health / Protocol 为最终事实，而不是只相信自己刚创建的子进程。

`service restart` 发现当前运行时属于 Desktop / 前台 CLI 时不得强制接管。

## 8. Windows 无窗口运行

npm 后台：

```text
Task Scheduler
  -> powershell.exe -WindowStyle Hidden
  -> node dist/cli.mjs service run
```

Desktop CLI：

```text
PowerShell / CMD
  -> agent-lens.cmd
  -> AgentLens.exe (ELECTRON_RUN_AS_NODE=1)
  -> runtime/cli.mjs
```

Hook：

```text
Native Hook
  -> powershell.exe -WindowStyle Hidden
  -> windows-hook-dispatcher.ps1
  -> ProcessStartInfo(CreateNoWindow=true)
  -> Node / Electron-as-Node Hook
```

这些包装只解决发行与 Windows 进程启动问题，不属于第二套 AgentLens Runtime。

## 9. 当前自动验收

三平台 CI 继续执行：

- 类型检查；
- 单元测试；
- 正式发行构建；
- Daemon / Web 冒烟；
- npm pack 内容检查。

Windows 额外验证：

- 用户级后台任务注册；
- 登录自启；
- 后台任务隐藏窗口定义；
- `owner=service` Health；
- `doctor` 生命周期一致性；
- 共享 Hook 分发器 stdin -> Durable Inbox；
- 陈旧 Desktop 登记存在时自动回退有效 npm Provider；
- 无有效 1.x npm 时，Installer 安装后 `agent-lens` 必须解析到 Desktop shim，`agent-lens -h` 必须成功；
- 模拟有效 1.x npm 后，npm PATH 必须排在 Desktop PATH 前，`agent-lens` 必须优先解析到 npm；
- 覆盖升级后 npm/Desktop 优先级不能反转，本地数据不能丢失；
- 模拟卸载 npm 后，不重装 Desktop 即可自动回退 Desktop CLI；
- 卸载 Desktop 后必须清掉自己的 PATH 项，同时保留 npm PATH、npm CLI 和 npm package。

## 10. 仍需人工实机验收

自动化不能替代以下体验检查：

- 只安装 Windows Desktop：重新打开 PowerShell 后 `agent-lens -h` 可直接运行；
- 先安装 npm 1.x、再安装 Desktop：`Get-Command agent-lens -All` 中 npm 入口优先，Desktop 入口仅作兜底；
- 先安装 Desktop、后安装 npm 1.x：再次启动 Desktop 后 npm CLI 自动成为主入口；
- 同时存在 npm + Desktop 时卸载 npm：无需重装 Desktop，`agent-lens -h` 自动回退 Desktop；
- 同时存在 npm + Desktop 时卸载 Desktop：npm CLI 与 npm PATH 完全不受影响；
- 机器上仍有 0.x npm CLI 时安装 alpha.2：`agent-lens` 不得继续解析到 0.x；
- Windows 登录后的肉眼无黑框；
- Desktop 登录自启开关与 Windows 系统实际状态一致；
- 真实 Codex / Claude Code Hook 是否完全无闪窗；
- npm service 已运行时启动 Desktop，只复用一个 Daemon；
- Desktop 已运行时再启动 npm service，最终仍只有一个 Daemon；
- Desktop 与 npm 都安装后轮流启动；
- 两边都设置登录自启时最终只有一个 Daemon；
- 退出 Desktop 时，如果复用外部 npm / service Daemon，外部 Daemon 继续运行；
- 卸载 npm 后 Desktop Hook 继续工作；
- 卸载 Desktop 后 npm Hook 继续工作；
- 长时间 SSE 断线 / Daemon 异常恢复不制造重复采集或第二 Runtime；
- Linux 常见发行版 / WSL 的 `systemd --user`；
- macOS LaunchAgent 登录加载 / 停止 / 重启。

## 11. 禁止回退

不得因为处理安装 / 卸载问题重新引入：

- PID 事实文件；
- 0.x Service Manager；
- Hook 自动拉起 Daemon；
- npm 与 Desktop 各自数据库；
- 两个默认 Daemon；
- Hook 分发器中的 Source / Canonical / SQLite / HTTP 业务逻辑。
