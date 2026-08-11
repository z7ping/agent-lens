# AgentLens Runtime Layout Design

## 目标

AgentLens 的开发运行数据不再散落在项目根目录。安装后的程序和运行数据统一归入用户主目录 `~/.agent-lens/`，同时保持程序、依赖和用户数据边界清晰，并支持从历史布局安全升级。

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
├── app/
│   ├── cli.js
│   ├── server.js
│   ├── package.json
│   ├── node_modules/
│   ├── dist/
│   ├── hooks/
│   ├── adapters/
│   └── importers/
├── bin/
│   └── agent-lens.cmd
├── data/
├── logs/
├── state/
└── run/
```

## 设计

新增 `server/runtime-paths.js`，集中导出运行时目录和文件路径。业务模块不再手写 `logs/`、`states/`、`projects.json`、`agent-lens.db`、`.server.pid` 的位置。

`server/cli.js` 负责创建 `~/.agent-lens/`，把应用文件暂存并切换到 `app/`，再将 Windows 命令入口写入 `bin/`。Hook 配置指向 `~/.agent-lens/app/hooks/prelog.js` 和 `~/.agent-lens/app/hooks/log.js`。服务工作目录使用 `~/.agent-lens/app/`，运行数据写入根目录的 `data/`、`logs/`、`state/`、`run/` 子目录。

安装阶段使用 `npm install --omit=dev --package-lock=false --registry=https://registry.npmjs.org/`，不复用开发环境锁文件，只从 npm 官方 Registry 安装 SQLite 等生产运行依赖。仓库通过 `.npmrc` 和发布配置固定官方 Registry，前端在发布前构建，用户安装时直接复制 `dist/`。

## 迁移

安装器识别三种布局：

1. 目标布局：`~/.agent-lens/app` 与根目录运行数据分层。
2. 当前平铺布局：程序、`node_modules` 与运行数据共同位于 `~/.agent-lens`。
3. 旧平台布局：Windows `%LOCALAPPDATA%/AgentLens`、macOS Application Support 或 Linux XDG 目录。

新程序先写入 `.update/app`，依赖验证通过后停止已知旧进程并切换到正式 `app/`。当前平铺布局的运行数据位置不变；新服务通过 PID 与 HTTP 就绪检查后，按白名单清理根目录旧程序文件和历史回滚目录。新服务启动失败或安装切换后抛出异常时，安装器自动恢复上一版 `app/` 并尝试重新启动服务。旧平台布局只复制目标目录中缺失的数据，遇到同名文件不覆盖并保留旧目录。

Hook 命令对脚本路径加引号，兼容用户主目录包含空格的环境。卸载通过同一 Hook 管理脚本清理 Claude Code、Codex、Cursor 配置，并按剩余 Codex Hooks 重建信任状态。

## 验证

路径测试覆盖开发模式、目标安装模式、当前平铺模式和旧平台模式。迁移测试验证缺失文件复制、冲突保留、暂存切换、失败回滚和白名单清理；Hook 测试覆盖空格路径、跨工具卸载和 Codex 信任状态重建；包测试禁止锁文件重新引入非官方 Registry。现有测试、构建、生产依赖安装和 npm pack dry-run 继续作为回归验证。
