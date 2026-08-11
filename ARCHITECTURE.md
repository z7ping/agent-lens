# AgentLens 架构文档

> 最后更新：2026-08-11
> 目的：记录技术架构和关键决策，防止迭代中反复踩坑

---

## 1. 系统架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                        AgentLens                                │
├─────────────────────────────────────────────────────────────────┤
│  前端 (Vite + Tailwind)          后端 (Node.js + SQLite)        │
│  ┌─────────────────────┐         ┌─────────────────────┐       │
│  │  调用链 Tab          │  ◄──►  │  HTTP Server :56789 │       │
│  │  仪表盘 Tab          │        │  ┌───────────────┐  │       │
│  │  概览 Tab            │        │  │  /api/overview│  │       │
│  └─────────────────────┘        │  │  agent-lens.db     │  │       │
│                                 │  │ timeline/overview │ │       │
│                                 │  └───────────────┘  │       │
│                                 └─────────────────────┘       │
└─────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ 数据写入
                    ┌───────────────┼───────────────┐
                    │               │               │
            ┌───────┴───────┐ ┌─────┴─────┐ ┌───────┴───────┐
            │   Hermes      │ │  Hooks    │ │   OpenCode    │
            │   (轮询DB)    │ │ (实时)    │ │   (轮询DB)    │
            └───────────────┘ └───────────┘ └───────────────┘
```

---

## 2. 数据采集方式对比

AgentLens 同时使用实时 Hook、历史 JSONL 导入和本地数据库轮询。Hook 负责低延迟工具观测，历史数据源负责补齐对话和未安装 Hook 时产生的任务。

| 适配器 | 主要采集方式 | 数据来源 | 用户消息 | AI 可见回复 | 工具调用 |
|--------|--------------|----------|:--------:|:----------:|:--------:|
| **Hermes** | SQLite 轮询 | `state.db` 的 messages / sessions | ✅ | ✅ | ✅ |
| **Claude Code** | 实时 Hook + JSONL 增量导入 | Hook stdin、`~/.claude/projects/**/*.jsonl` | ✅（历史） | ✅（历史） | ✅ |
| **Codex** | 实时 Hook + JSONL 增量导入 | Hook stdin、`~/.codex/sessions/**/*.jsonl` | ✅（历史） | ✅（历史） | ✅ |
| **OpenCode** | SQLite 轮询 | `opencode.db` 的 session / message / part | ✅ | ✅ | ✅ |
| **Pi** | JSONL 轮询 | Pi session JSONL | ✅ | ✅ | ✅ |
| **Cursor** | 实时 Hook | Hook stdin | ❌ | ❌ | ✅ |
| **OpenClaw** | 骨架 | 尚未实现 | ❌ | ❌ | ❌ |

### 数据完整度边界

- Claude Code 与 Codex 的实时 Hook 当前只安装 `PreToolUse` 和 `PostToolUse`，实时链路主要包含工具调用；用户和助手消息来自历史 JSONL 导入。
- 历史文件不存在、会话持久化被关闭或格式发生变化时，对话记录可能缺失。
- 用户消息和助手可见回复不等于模型收到的完整提示输入；系统指令、Developer 指令、项目规则、Skills、工具描述和 Memory 可能未被当前导入器保留。
- AgentLens 不承诺获得模型未公开的隐藏思维过程。Pi 等来源若在原生日志中公开 thinking，只能按该来源的可见数据展示。
- 工具参数会按类型摘要，输出与错误会截断，当前 Timeline 不是完整原始事件归档。

---

## 3. Timeline 表结构

```sql
CREATE TABLE timeline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,           -- 数据来源：hermes/claude-code/codex/opencode/pi/cursor
  session_id TEXT NOT NULL,       -- 会话标识
  timestamp TEXT NOT NULL,        -- ISO 8601 时间戳
  seq INTEGER,                    -- 序号（hooks适配器使用）
  role TEXT NOT NULL,             -- user/assistant/tool_result/tool_error
  tool_name TEXT,                 -- 工具名称（仅tool角色有值）
  content TEXT,                   -- 消息内容（user/assistant）或工具输出（tool）
  tool_input TEXT,                -- 工具输入参数JSON
  success INTEGER,                -- 0=失败 1=成功（仅tool角色）
  exit_code INTEGER,              -- 退出码（仅bash类工具）
  duration_ms REAL,               -- 耗时毫秒
  output_snippet TEXT,            -- 输出摘要（前500字符）
  error_message TEXT,             -- 错误消息
  error_type TEXT,                -- 错误分类
  error_detail TEXT,              -- 错误详情JSON
  project_key TEXT,               -- 项目标识（工作目录MD5前12位）
  parent_seq INTEGER              -- 父调用序号（用于重建调用树）
);
```

### role 字段语义

| role | 含义 | 来源 |
|------|------|------|
| `user` | 用户输入的消息 | Hermes、Claude Code/Codex 历史导入、OpenCode、Pi |
| `assistant` | AI对用户可见的文字回复 | Hermes、Claude Code/Codex 历史导入、OpenCode、Pi |
| `tool_result` | 工具调用成功 | 所有适配器 |
| `tool_error` | 工具调用失败 | 所有适配器 |

---

## 4. 概览资产快照

“概览”页展示当前机器上各 AI 工具的稳定能力资产。它和工具栈地图不同：

- 工具栈地图回答“哪些工具调用表现好、风险高、常形成链路”。
- 概览回答“每个 AI 工具装了什么能力资产、这些能力在其他工具中是否也具备”。

### 4.1 数据表

概览稳定资产写入运行时数据目录中的 `agent-lens.db`：

```sql
overview_tools (
  tool TEXT PRIMARY KEY,
  display_name TEXT,
  description TEXT,
  version TEXT,
  status TEXT,
  config_dir TEXT,
  theme_json TEXT,
  last_scanned_at TEXT
)

overview_assets (
  tool TEXT,
  name TEXT,
  capability TEXT,
  type TEXT,
  status TEXT,
  path TEXT,
  description TEXT,
  last_scanned_at TEXT,
  PRIMARY KEY (tool, capability, type, path)
)

overview_scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  status TEXT,
  tool_count INTEGER,
  asset_count INTEGER,
  error_message TEXT
)
```

`overview_tools` 和 `overview_assets` 存低频变化的事实：版本、配置目录、资产清单、路径和状态。调用次数、高频资产、跨工具覆盖矩阵不作为稳定事实重复存储，而是在查询时从 `timeline` 聚合后合并。

### 4.2 刷新策略

概览采用“快照优先，后台刷新”：

1. 前端请求 `/api/overview`。
2. 后端优先读取 `overview_tools` / `overview_assets` 快照。
3. 响应返回后排队一次后台扫描，扫描完成后更新快照表。
4. 服务启动后启动定时扫描。
5. 前端还会缓存上一次 `/api/overview` 结果，首屏可先渲染缓存或稳定工具骨架。

服务端定时扫描间隔由 `AGENT_LENS_OVERVIEW_SCAN_INTERVAL_MS` 控制，默认 10 分钟，设为 `0` 可关闭定时扫描。访问 `/api/overview` 仍会触发后台刷新。

### 4.3 Pi 资产发现规则

Pi 的配置根由 `PI_CODING_AGENT_DIR` 控制，默认是 `~/.pi/agent`。概览扫描不会把 `~/.pi` 当成唯一固定布局，而是先归一化 Pi agent 根目录候选，再在 agent 根下扫描稳定资产。

Pi agent 根目录候选：

- `PI_CODING_AGENT_DIR`
- `PI_HOME`
- `PI_AGENT_HOME`
- `PI_CONFIG_HOME`
- `PI_DATA_HOME`
- `~/.pi/agent`
- `~/.pi`
- `~/.config/pi`
- `~/.local/share/pi`
- `%APPDATA%\Pi` / `%APPDATA%\pi`
- `%LOCALAPPDATA%\Pi` / `%LOCALAPPDATA%\pi`
- `~/Library/Application Support/Pi` / `~/Library/Application Support/pi`

候选目录只有在出现 Pi agent 标记时才会参与扫描：`npm/package.json`、`extensions`、`skills`、`pi-hermes-memory` 或 `projects-memory`。

识别到 agent 根目录后扫描：

- Skill 资源扫描会识别根目录 `.md` 文件，并递归识别包含 `SKILL.md` 的子目录；Extension 资源扫描会识别子目录以及 `.js` / `.ts` / `.mjs` / `.cjs` 文件。
- `<agentDir>/skills`：Pi 用户级默认 Skill 目录。
- `~/.agents/skills`：Pi / Agent Skills 共享的用户级 Skill 目录。
- `<agentDir>/settings.json` 中的 `skills`：Pi 配置显式加载的 Skill 目录。
- `<agentDir>/settings.json` 中的 `extensions`：Pi 配置显式加载的 Extension 路径。
- `<agentDir>/settings.json` 中的 `packages`：Pi 配置显式安装的 package，`npm:<package>` 会映射到 `<agentDir>/npm/node_modules/<package>`。
- `<agentDir>/npm/package.json` 与 `<agentDir>/npm/node_modules/<package>`：Pi npm 插件。包名 `pi-*`、scope 内含 `/pi-*`、`package.json` 中有 `pi` 字段，或 `keywords` 含 `pi-extension` / `pi-package` / `pi-*` 时视为 Pi 插件。
- `<agentDir>/npm/node_modules/<package>/skills`：插件随包提供的传统 Skill 目录。
- `<agentDir>/npm/node_modules/<package>/package.json` 中的 `pi.skills` / `skills`：Pi package 声明的 Skill 资源。
- `<agentDir>/extensions`：Pi extension。
- `<agentDir>/npm/node_modules/<package>/extensions`：插件随包提供的传统 Extension 目录。
- `<agentDir>/npm/node_modules/<package>/package.json` 中的 `pi.extensions` / `extensions`：Pi package 声明的 Extension 资源。
- `<agentDir>/pi-hermes-memory/skills`：Pi Hermes Memory 提供的 Skill。
- `<agentDir>/projects-memory/<project>/skills`：项目级记忆 Skill。

---

## 5. 关键设计决策

### 5.1 为什么用轮询而不是实时推送？

**决策**：Hermes 和 OpenCode 使用轮询（30分钟间隔）+ fs.watch 补充。

**原因**：
- state.db 和 opencode.db 是 SQLite 文件，无法直接监听变更
- fs.watch 可以检测文件修改，但不能保证实时性（可能漏事件）
- 30分钟轮询是兜底机制，确保数据不丢失

**权衡**：牺牲实时性换取可靠性。hooks 适配器是实时的，但数据不完整。

### 5.2 为什么同时保留 Hook 和历史导入？

**决策**：支持 Hook 的来源仍保留历史 JSONL 或数据库导入。

**原因**：
- Hook 适合低延迟捕获工具调用，但当前安装范围不能覆盖完整对话和全部生命周期。
- 历史数据源可以补齐用户消息、助手可见回复和未安装 Hook 时产生的任务。
- 两种来源互为补充，并通过幂等标识和导入水位线避免重复写入。

**影响**：同一来源需要同时维护实时适配器和历史解析器；界面必须说明记录来自运行时捕获还是历史导入，不能把二者混合描述为完整提示词。

### 5.3 为什么用 timeline 表而不是 sessions 表？

**决策**：前端主要查询 timeline 表，sessions 表只用于统计。

**原因**：
- timeline 表存储原始事件，支持灵活查询
- sessions 表是聚合数据，用于快速统计
- 分离关注点：timeline 负责详情，sessions 负责概览

### 5.4 为什么 call-item 用容器而不是分开的边框？

**决策**：call-row 和 call-detail 共享一个 call-item 容器，容器画左边线。

**原因**：
- 避免 call-row 和 round-header 的边框视觉冲突
- 统一缩进：call-item 有 ml-4 缩进，与 round-header 对齐
- 简化样式管理：一条边线控制，不需要分别调整

---

## 6. 已知限制

### 6.1 数据完整性限制

| 限制 | 影响 | 临时解决方案 |
|------|------|-------------|
| 实时 Hook 主要只有工具事件 | 新任务对话可能需要等待历史导入 | 使用 JSONL/数据库轮询补齐 |
| Cursor 无对话历史导入 | 只能复盘工具调用 | 在来源能力矩阵中明确标记 |
| 提示词组成不完整 | 不能还原全部模型可见输入 | 区分捕获、扫描、诊断、推断和不可观察 |
| 工具输入输出被摘要 | 不能把 Timeline 当作完整审计日志 | 保留来源引用，敏感原文按需读取 |
| OpenClaw 尚未实现 | 无可用任务数据 | 保持为规划状态 |

### 6.2 实时性限制

| 限制 | 影响 | 缓解措施 |
|------|------|----------|
| 轮询间隔30分钟 | 新数据最多延迟30分钟 | fs.watch检测到变更时立即触发 |
| fs.watch可能漏事件 | 极端情况数据丢失 | 30分钟轮询兜底 |
| 无WebSocket推送 | 需手动刷新才能看到新数据 | 3秒轮询前端（仅统计） |
| 概览资产不是实时事实 | 新装插件/Skill 可能延迟出现 | 访问概览触发后台刷新 + 定时扫描 |

### 6.3 性能限制

| 限制 | 影响 | 当前处理 |
|------|------|----------|
| state.db 460MB+ | 全表扫描慢 | 水位线优化，只查增量 |
| 单次LIMIT5000 | 大会话可能截断 | 分批加载（未实现） |
| 前端无虚拟滚动 | 大量会话渲染慢 | 分页显示（100条/页） |

---

## 7. 数据流详解

### 7.1 Hermes 数据流

```
Hermes Agent
    │
    ▼
state.db (messages表)
    │
    ├──► hermes.js adapter (轮询)
    │       │
    │       ▼
    │    agent-lens.db (timeline表)
    │       │
    │       ▼
    │    HTTP API (/api/timeline)
    │       │
    │       ▼
    │    前端渲染 (callchain/index.js)
    │
    └──► hermes plugin (hooks)
            │
            ▼
         POST /api/hook (实时推送)
            │
            ▼
         agent-lens.db (timeline表)
```

### 7.2 Hooks 适配器数据流

```
Claude Code / Codex / Pi / Cursor
    │
    ├──► PreToolUse hook (prelog.js)
    │       │
    │       ▼
    │    JSONL文件 (.agent-lens/logs/<projectKey>.jsonl)
    │    状态文件 (.agent-lens/state/<projectKey>.json)
    │
    └──► PostToolUse hook (log.js)
            │
            ▼
         JSONL文件 + POST /api/hook
            │
            ▼
         agent-lens.db (timeline表)
            │
            ▼
         HTTP API → 前端
```

---

### 7.3 概览数据流

```
服务启动 / 访问概览 / 定时器
    │
    ▼
overview.js 扫描本机 AI 工具环境
    │
    ├── 工具版本、配置目录、状态
    ├── Skills / MCP / Plugins / Extensions / Hooks / Adapters
    ▼
agent-lens.db
    ├── overview_tools
    ├── overview_assets
    └── overview_scan_runs
    │
    ├── timeline 聚合调用次数
    ▼
/api/overview
    │
    ▼
前端概览 Tab
    ├── 每工具一张卡片
    ├── 紧凑资产卡片
    └── 高频资产跨工具覆盖矩阵
```

---

## 8. 前端渲染逻辑

### 8.1 调用链 Tab 渲染流程

```
1. loadCallChain()
   └─► fetch /api/sessions
   └─► renderCallChain(sessions)
       └─► 按时间排序，显示会话列表

2. toggleSession(card)
   └─► loadSessionCalls(card)
       └─► fetch /api/timeline?session=<id>
       └─► renderCallChainCalls(calls)
           └─► groupByRounds(calls)
               └─► 按role=user分割轮次
           └─► renderRound(round)
               └─► 渲染用户消息、AI回复、工具调用
```

### 8.2 轮次分组逻辑

```javascript
// groupByRounds 函数
for (const call of calls) {
  if (call.role === 'user') {
    // 新建轮次，以用户消息开头
    currentRound = { userMessage: call, toolCalls: [], assistantMessages: [] };
  } else if (call.role === 'assistant') {
    // AI回复，加入当前轮次
    currentRound.assistantMessages.push(call);
  } else if (call.role === 'tool_result' || call.role === 'tool_error') {
    // 工具调用，加入当前轮次
    currentRound.toolCalls.push(call);
  }
}
```

### 8.3 视觉层级

```
Session Card (来源色左边线)
├── Session Header (时间、工具数、错误数)
└── Session Body (展开后)
    ├── Round Header (轮次色左边线)
    │   ├── 第 N 轮
    │   ├── 用户消息 (round-user-msg)
    │   └── N 次调用
    ├── Round Calls (工具色左边线)
    │   ├── Call Item (工具色左边线)
    │   │   ├── Call Row (工具名、输入摘要)
    │   │   └── Call Detail (展开后：完整输入输出)
    │   └── ...
    └── Round Assistant (AI回复)
        ├── AI 标签
        └── 回复文本
```

---

## 9. 颜色系统

| 来源 | 颜色 | 用途 |
|------|------|------|
| hermes | #a855f7 (紫色) | Session边框、轮次边框 |
| claude-code | #f97316 (橙色) | Session边框、轮次边框 |
| codex | #22c55e (绿色) | Session边框、轮次边框 |
| opencode | #3b82f6 (蓝色) | Session边框、轮次边框 |
| pi | #ec4899 (粉色) | Session边框、轮次边框 |
| cursor | #06b6d4 (青色) | Session边框、轮次边框 |

| 工具类型 | 颜色 | 用途 |
|----------|------|------|
| bash | #3b82f6 (蓝色) | Call-item边框、工具标签 |
| read | #f97316 (橙色) | Call-item边框、工具标签 |
| write | #22c55e (绿色) | Call-item边框、工具标签 |
| mcp | #a855f7 (紫色) | Call-item边框、工具标签 |
| agent | #ec4899 (粉色) | Call-item边框、工具标签 |

---

## 10. 未来改进方向

### 10.1 数据完整性（高优先级）

- [ ] OpenCode适配器：验证opencode.db是否包含user/assistant消息
- [ ] 考虑从JSONL文件提取user/assistant消息（如果存在）
- [ ] 文档化各工具的hook事件能力

### 10.2 实时性（中优先级）

- [ ] WebSocket推送新数据
- [ ] 减少轮询间隔（30分钟→5分钟）
- [ ] 前端自动刷新新会话

### 10.3 性能（低优先级）

- [ ] 虚拟滚动（大量会话）
- [ ] 分批加载（大会话的工具调用）
- [ ] 数据归档（旧数据压缩）

---

## 11. 踩坑记录

### 11.1 Codex hooks 信任机制

**问题**：修改 hooks.json 后，codex 静默跳过所有 hooks。

**原因**：codex 使用 per-hook SHA256 哈希验证信任，不是 whole-file 哈希。

**解决**：
- 哈希计算：`SHA256(canonical_json(NormalizedHookIdentity))`
- NormalizedHookIdentity = event_name + matcher + group(handler)
- 事件名用 snake_case（`pre_tool_use`，不是 `pretooluse`）

**教训**：不要假设工具的行为，读源码确认。

### 11.2 call-item 边框冲突

**问题**：call-row 和 round-header 的左边线在同一水平位置，视觉冲突。

**尝试的方案**：
1. call-item 容器画一条线，call-row/call-detail 共享 → 破坏缩进
2. 移除 call-row 边框，只保留 call-detail → 用户不满意
3. 最终方案：call-item 容器 + ml-4 缩进 + call-detail 无额外margin

**教训**：UI改动要截图验证，不能只看代码。

### 11.3 Hermes timeline 数据缺失

**问题**：hermes session 展开后显示"暂无调用记录"。

**原因**：水位线初始化时只查 MAX(timestamp)，跳过了更早的 user/assistant 消息。

**实际状态**：timeline 表有数据（user:563, assistant:2378），但 API 查询时被水位线过滤。

**教训**：水位线逻辑要考虑所有 role，不只是 tool_result。

---

## 附录：文件结构速查

```
server/
├── adapters/
│   ├── base.js              # 适配器基类
│   ├── hermes.js            # Hermes（轮询state.db）
│   ├── claude-code.js       # Claude Code（hooks）
│   ├── codex.js             # Codex（hooks）
│   ├── opencode.js          # OpenCode（轮询opencode.db）
│   ├── pi.js                # Pi（hooks）
│   ├── cursor.js            # Cursor（hooks）
│   └── index.js             # 适配器注册表
├── hooks/
│   ├── prelog.js            # PreToolUse hook脚本
│   └── log.js               # PostToolUse hook脚本
├── agent-lens-db.js              # SQLite存储层（timeline表）
├── server.js                # HTTP服务
├── routes.js                # API路由
└── install-hooks.js         # 安装hooks到各工具

src/
├── app.js                   # 主逻辑（加载、过滤、切换）
├── callchain/
│   └── index.js             # 调用链渲染（轮次分组、会话卡片）
├── dashboard/
│   └── index.js             # 仪表盘渲染（图表、统计）
└── style.css                # 全局样式
```
