# AgentLens Runtime Layout Design

## 目标

AgentLens 的开发运行数据不再散落在项目根目录，安装后的代码、数据、状态、日志和短生命周期运行文件按职责分目录。

## 目录布局

开发模式使用项目根目录下的 `.agent-lens/`：

```text
.agent-lens/
├── data/
│   ├── agent-lens.db
│   └── projects.json
├── logs/
├── state/
└── run/
    └── server.pid
```

Windows 安装模式使用 `%LOCALAPPDATA%\AgentLens\`：

```text
%LOCALAPPDATA%\AgentLens\
├── app/
├── data/
├── logs/
├── state/
└── run/
```

Linux/macOS 安装模式使用 XDG 风格目录：

```text
~/.local/share/agent-lens/app/
~/.local/share/agent-lens/data/
~/.local/state/agent-lens/logs/
~/.local/state/agent-lens/state/
~/.local/state/agent-lens/run/
```

## 设计

新增 `server/runtime-paths.js`，集中导出运行时目录和文件路径。业务模块不再手写 `logs/`、`states/`、`projects.json`、`agent-lens.db`、`.server.pid` 的位置。

`server/cli.js` 负责安装时创建安装目录树，并把应用文件复制到 `app/`。Hook 配置指向 `app/hooks/prelog.js` 和 `app/hooks/log.js`。服务工作目录使用 `app/`，但运行数据写入同级 `data/`、`logs/`、`state/`、`run/`。

## 验证

新增路径测试覆盖开发模式和 Windows 安装模式。现有测试、构建和 npm pack dry-run 继续作为回归验证。
