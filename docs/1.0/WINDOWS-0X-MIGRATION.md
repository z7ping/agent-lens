# AgentLens 0.x → 1.x Windows 运行时迁移

更新日期：2026-08-28  
适用版本：`1.0.0-alpha.2` 起

## 目标

Windows 用户从 0.x CLI / 后台服务迁移到 1.x Desktop 时，不应因为旧运行时、旧登录启动项或默认端口 `56789` 残留而导致 1.x Desktop 无法启动。

本迁移只处理旧运行时的生命周期归属，不改变 1.x Canonical 数据模型，也不决定 Desktop 与 npm CLI 最终的 PATH 所有权。

## 已知 0.x Windows 形态

0.x Windows 安装使用以下结构：

```text
~/.agent-lens/
├── app/                 # 0.x 已安装应用
│   ├── package.json     # @z7ping/agent-lens 0.x
│   └── server.js        # 0.x 默认运行时入口
└── run/server.pid       # 历史 PID 文件

%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/
└── AgentLens.vbs        # 登录后启动 ~/.agent-lens/app/server.js
```

0.x 默认监听 `127.0.0.1:56789`，并提供 `/api/app-info`。

## 1.x Desktop 迁移顺序

Desktop 启动时按以下顺序处理：

```text
创建启动窗口 / 托盘
        ↓
检查旧版 Windows 启动项
        ↓
识别 56789 上的旧 0.x Runtime
        ↓
确认旧运行时身份与进程归属
        ↓
停止确认属于 0.x 的旧进程
        ↓
移除旧 AgentLens.vbs
        ↓
注册 / 刷新 1.x Desktop 登录自启
        ↓
启动或复用 1.x Runtime
```

迁移先于 1.x Runtime 启动，避免 0.x 与 1.x 同时竞争默认端口和共享数据目录。

## 身份确认边界

自动停止进程必须同时满足“旧版身份成立”和“实际监听进程归属成立”。

旧版身份可以来自：

- `http://127.0.0.1:56789/api/app-info` 返回 `@z7ping/agent-lens` 且主版本为 `0`；
- `~/.agent-lens/app/package.json` 为 `@z7ping/agent-lens` 且主版本为 `0`。

实际监听进程还必须满足：

- 进程确实监听目标端口；
- Windows 进程命令行指向已知 `~/.agent-lens/app`；
- 命令行入口为旧 `server.js` / `cli.js`。

只有满足这些条件才允许停止旧进程。单独出现“端口 56789 被占用”绝不是强杀依据。

## 无法确认归属时

如果端口被占用但无法证明属于 AgentLens 0.x：

- 不停止该进程；
- 不启动第二个默认 Runtime；
- Desktop 显示可读错误；
- JS 调用栈仅写入桌面 / Daemon 日志。

这条边界用于避免误杀用户的其他本地服务。

## 旧登录启动项

只删除内容明确引用 `~/.agent-lens/app/server.js` 的 `AgentLens.vbs`。

文件同名但内容不属于已知 0.x AgentLens 时不删除。

迁移完成后写入：

```text
~/.agent-lens/1.0/runtime/migrations/legacy-windows-0x.json
```

记录检测版本、停止的 PID、是否移除旧启动项、身份来源与迁移时间。该文件只是本地生命周期迁移记录，不是 Canonical Observation 或第二事实源。

## CLI 边界

`alpha.2` 不静默执行：

```text
npm uninstall -g @z7ping/agent-lens
```

也不主动重写用户 PATH。

因此机器上如果仍保留 0.x npm 全局 CLI，`where.exe agent-lens` 仍可能解析到旧命令。`alpha.2` 的目标是让该旧安装不再通过旧 `AgentLens.vbs` 自动拥有默认 Runtime；Desktop 与 npm CLI 的最终命令入口所有权另行设计。

## 实机验收

至少覆盖：

1. 已安装并运行 `0.7.0`，旧 `AgentLens.vbs` 存在，56789 被 0.x 占用；安装 / 启动 `1.0.0-alpha.2` 后自动接管，最终 `/api/v1/health` 为 Protocol 1.0。
2. 0.x 已安装但未运行，仅旧 `AgentLens.vbs` 残留；启动 1.x 后旧启动项被退役，1.x 正常启动。
3. 56789 被非 AgentLens 程序占用；1.x 不得杀进程，应阻断第二 Runtime 并给出诊断。
4. 0.x `/api/app-info` 暂时不可用，但旧安装 `package.json` 与监听进程路径都能确认；仍可安全完成接管。
5. 重复启动 1.x；迁移流程保持幂等，不重复破坏数据或生命周期配置。
6. 迁移过程中 `~/.agent-lens/1.0` 数据始终保留。
