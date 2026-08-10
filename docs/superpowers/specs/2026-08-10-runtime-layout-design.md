# AgentLens Runtime Layout Design

## 目标

AgentLens 的开发运行数据不再散落在项目根目录。安装后的程序和运行数据统一放在用户主目录 `~/.agent-lens/`，不使用平台专有目录，也不处理旧布局迁移。

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

所有平台安装模式统一使用 `~/.agent-lens/`，Windows 对应 `C:\Users\<用户名>\.agent-lens\`：

```text
~/.agent-lens/
├── cli.js
├── server.js
├── package.json
├── dist/
├── hooks/
├── adapters/
├── importers/
├── data/
├── logs/
├── state/
└── run/
```

## 设计

新增 `server/runtime-paths.js`，集中导出运行时目录和文件路径。业务模块不再手写 `logs/`、`states/`、`projects.json`、`agent-lens.db`、`.server.pid` 的位置。

`server/cli.js` 负责创建 `~/.agent-lens/`，并把应用文件直接复制到根目录。Hook 配置指向 `~/.agent-lens/hooks/prelog.js` 和 `~/.agent-lens/hooks/log.js`。服务工作目录使用 `~/.agent-lens/`，运行数据写入其 `data/`、`logs/`、`state/`、`run/` 子目录。

旧安装目录和旧运行数据不迁移；重新安装时可直接删除后按新布局创建。

## 验证

路径测试覆盖开发模式和统一安装模式。现有测试、构建和 npm pack dry-run 继续作为回归验证。
