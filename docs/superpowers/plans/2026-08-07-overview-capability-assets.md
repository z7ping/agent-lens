# 概览能力资产 实施计划

> **给 agent 工作者：** 必选子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐项实施本计划。步骤用复选框（`- [ ]`）语法跟踪。

**目标：** 构建一个只读的"概览"页面，展示每个 AI 编码工具的能力资产，并高亮跨工具高频使用的能力。

**架构：** 新增一个聚焦的后端模块，基于静态工具元数据、本地文件系统扫描和 timeline 调用次数构建概览数据。新增一个路由和前端 Tab，每个工具渲染一张卡片，外加一个紧凑的跨工具高频矩阵。

**技术栈：** Node.js CommonJS 后端、better-sqlite3 timeline 数据、原生浏览器 JavaScript、沿用现有 CSS/Tailwind 工具类样式。

---

### 任务 1：后端概览数据

**文件：**
- 新建：`server/overview.js`
- 测试：`test/overview.test.js`

- [ ] 编写工具分组、高频资产标记、矩阵覆盖的失败测试。
- [ ] 运行 `node --test test/overview.test.js`，验证测试因 `server/overview.js` 不存在而失败。
- [ ] 实现 `buildOverview()` 和 `queryOverview()`。
- [ ] 运行 `node --test test/overview.test.js`，验证通过。

### 任务 2：API 路由

**文件：**
- 修改：`server/routes.js`
- 修改：`server/server.js`
- 修改：`src/utils.js`

- [ ] 新增 `handleApiOverview`。
- [ ] 挂载 `/api/overview`。
- [ ] 新增 `fetchOverview()`。
- [ ] 运行概览和相关路由测试。

### 任务 3：前端页面

**文件：**
- 新建：`src/overview/index.js`
- 修改：`src/app.js`
- 修改：`index.html`
- 修改：`src/style.css`

- [ ] 新增一级"概览" Tab。
- [ ] 渲染工具卡片和高频跨工具覆盖。
- [ ] 打开 Tab 时加载数据。
- [ ] 保留现有的来源/项目过滤栏，供回放和工具站页面使用，不阻塞概览。

### 任务 4：验证

**文件：**
- 既有测试套件与生产构建。

- [ ] 运行 `node --test`。
- [ ] 运行 `npm run build`。
- [ ] 按需启动本地开发服务器并检查页面。
