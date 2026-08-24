# ADR-0004：双发行、单运行时与互斥生命周期

状态：Accepted  
日期：2026-08-24

## 背景

AgentLens 1.0 同时需要支持两种正式使用方式：

1. npm / CLI：面向开发者、无桌面环境和希望自行管理后台运行的用户；
2. Windows 客户端：面向希望使用安装包、托盘和系统登录自启的用户。

两种发行方式都必须使用同一套 1.0 Core、Cordis Runtime、Canonical Observation / Evidence、Protocol 和数据目录。它们不能演进成两套 AgentLens，也不能在同一台机器上各自启动一个 Daemon、重复采集或争用同一端口。

0.x 曾提供完整的跨平台 service manager、PID、Windows 启动项等能力，但 1.0 Clean Rebuild 已明确不恢复旧 service manager / PID Runtime。需要恢复的是“安装一次后可以长期稳定运行”的产品能力，而不是旧实现。

## 决策

### 1. 两种发行方式都是一等公民

AgentLens 正式支持：

- npm / CLI 发行；
- Windows Desktop 发行。

两者复用同一套 `dist/daemon.mjs`、Web、Hook 事件格式、Protocol 和 Canonical 数据模型。

Desktop 不是另一套 Runtime，npm 也不是 Desktop 的安装前置条件。

### 2. 共享唯一数据根

两种发行方式默认共享：

```text
~/.agent-lens/1.0/
```

包括数据库、durable inbox、Vault / Backup 等 1.0 数据。

不得因为发行方式不同创建互不相容的数据库或观测事实副本。

### 3. 同一时刻只允许一个有效 Daemon

默认 HTTP 地址仍为：

```text
127.0.0.1:56789
```

Desktop 或 npm 后台服务在启动自己的 Daemon 前，必须先探测现有 AgentLens Daemon。

如果已有兼容的 1.0 Daemon：

- 不再启动第二个 Daemon；
- 直接复用现有 HTTP / SSE Surface；
- 不重复消费 durable inbox；
- 不重复执行 History / Asset 扫描。

如果现有 Daemon 协议不兼容，应明确报告版本 / 协议冲突，不允许通过换端口偷偷启动第二套 1.0 数据链路。

### 4. 生命周期所有权属于发行 / 运维层，不进入 Core

运行时生命周期允许有以下管理来源：

```text
cli
service
desktop
```

它们只回答“谁负责启动、停止、恢复这个 Daemon”，不改变 Canonical Data Flow，也不进入 Source / Storage / Projection 语义。

- `cli`：前台运行；
- `service`：npm 后台 / 系统自启入口；
- `desktop`：Electron 托盘与 Windows 登录生命周期。

不得把运行时所有权实现成第二套 DI、Plugin Runtime、Source Adapter 或 0.x PID Service Manager。

### 5. Desktop 可以管理 Daemon，也可以只连接 Daemon

Windows Desktop 启动时先探测已有 Daemon：

- 没有 Daemon：Desktop 启动并管理自己的 Daemon；
- 已有兼容 Daemon：Desktop 作为客户端连接，不接管、不停止它；
- Desktop 自己管理的 Daemon 异常退出时，才执行现有自动恢复策略。

因此退出 Desktop 时，只停止由当前 Desktop 进程启动并拥有的 Daemon；不能误杀 npm / service 启动的外部 Daemon。

### 6. Windows 登录自启启动 Desktop，不直接启动第二套 Daemon

客户端的“登录 Windows 后自动运行”启动 Electron Desktop 到托盘，由 Desktop 按第 5 条决定复用还是启动 Daemon。

不得恢复 0.x 的 VBS + PID + detached daemon 作为 Windows Desktop 的正式生命周期。

### 7. npm 后台能力使用操作系统原生用户级托管

npm 发行同时支持前台：

```text
agent-lens start
```

以及后台：

```text
agent-lens service start
agent-lens service stop
agent-lens service restart
agent-lens service status

agent-lens autostart enable
agent-lens autostart disable
agent-lens autostart status
```

后台能力不恢复 AgentLens 自己的 PID / Service Manager，而是映射到操作系统原生的用户级托管能力：

```text
Windows -> 当前用户 Task Scheduler
Linux   -> systemd --user
macOS   -> LaunchAgent / launchd
```

系统托管器统一执行内部入口：

```text
agent-lens service run
```

该入口启动同一个正式 Daemon，并报告：

```text
owner = service
mode  = managed
```

`service` 与 `autostart` 的语义必须分开：

- `service start/stop`：控制当前会话中的后台运行；
- `autostart enable/disable`：控制下次登录是否自动启动；
- Windows 计划任务可以无登录触发器存在，因此后台任务“已注册”不等于“已启用登录自启”；
- Linux 通过 `systemctl --user enable/disable` 管理登录自启；
- macOS 通过 LaunchAgent 的 `RunAtLoad` 表达登录自启意图。

源码开发模式不得把临时 `tsx` 入口注册进系统生命周期。调用 `service/autostart` 前必须先产生正式 `dist/cli.mjs`。

### 8. Hook 与发行方式解耦

Hook 仍然只是被动采集 Shim：

```text
Native Hook -> sanitize -> durable inbox
```

Hook 不依赖 Daemon 是否正在运行，也不负责拉起 Daemon。

npm 与 Desktop 可以使用不同的 Hook 可执行入口，但必须写入相同的 1.0 durable inbox 格式。卸载一种发行方式时，如果另一种发行仍存在，不得破坏仍有效的 AgentLens Hook 链路。

### 9. 版本与兼容检查优先于抢占

双发行共存时可能出现 npm 与 Desktop 版本不同。启动方必须优先检查已有 Daemon 的 Protocol / Runtime Compatibility。

兼容时复用；不兼容时明确要求升级或切换运行方式，不能静默启动另一套 Runtime。

`service restart` 如果发现当前运行时由 Desktop 或前台 CLI 管理，不得通过系统托管器强行杀掉并接管。

## 结果

### 正面结果

- npm 与 Desktop 都可以长期独立使用；
- npm 在 Windows / Linux / macOS 都有用户级后台常驻入口；
- 同机安装两种发行方式不会天然导致双 Daemon；
- 保留 1.0 Clean Rebuild 的单 Runtime / 单事实链；
- 恢复 0.x 的“长期无感运行”体验，而不恢复旧 service manager / PID 架构；
- Desktop、CLI、Task Scheduler、systemd 与 launchd 共享同一套运行时所有权和兼容语义。

### 代价

- npm 后台能力依赖各操作系统原生用户级托管器；
- Linux 用户环境需要可用的 `systemd --user`；
- macOS 生命周期需要在真实 LaunchAgent 环境继续做安装 / 登录 / 停止验收；
- Windows 计划任务需要继续实机确认后台 Node 进程不会造成控制台闪现；
- 双发行卸载、Hook 切换和版本不兼容需要显式测试；
- Windows 登录自启必须避免覆盖用户主动关闭自启的选择。

## 不做

本 ADR 不恢复：

- 0.x PID 文件作为 1.0 生命周期事实来源；
- 0.x service manager；
- 双端口并行运行两套 1.0 Daemon；
- Desktop 私有数据库；
- npm 私有数据库；
- Hook 自动拉起 Daemon。

## 第一阶段落地状态

已完成：

1. Desktop 启动前探测并复用已有兼容 Daemon；
2. Desktop 只停止自己拥有的 Daemon；
3. Windows Desktop 增加可关闭的登录自启；
4. Health / CLI 状态增加 Runtime 所有权与运行模式；
5. 增加 `agent-lens setup`；
6. 增加 npm `service` / `autostart`；
7. Windows 使用用户级 Task Scheduler；
8. Linux 使用 `systemd --user`；
9. macOS 使用 LaunchAgent / `launchd`；
10. 生命周期定义生成进入 CLI 自动测试。

仍需真实系统环境验收：

- Windows npm 后台启动 / 停止 / 登录自启 / 无控制台闪现；
- Linux `systemd --user` 在常见发行版与 WSL 环境中的行为；
- macOS LaunchAgent 登录加载、停止、重启行为；
- npm 与 Desktop 同时启用登录自启时的竞争启动与单 Daemon 复用。
