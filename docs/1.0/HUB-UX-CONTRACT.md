# AgentLens 1.0 Hub UX Contract

更新日期：2026-08-27  
状态：Alpha 产品交互设计约束，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-OPERATIONS.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/CAPTURE-POLICY.md`

本文只定义 Hub 在 Web / Desktop / CLI 中必须表达清楚的产品语义，不锁死具体页面布局，也不要求增加新的一级导航。正式 UI 仍需遵守 AgentLens 当前高信息密度、中文优先和本机可观测定位。

## 1. 用户术语

面向用户优先使用：

```text
设备
Hub
本机
远程设备
同步
同步策略
首次同步
同步校准
撤销连接
删除历史
```

内部可以继续使用：

```text
Node
Replication Stream
Replica Key
Shared Assertion
Identity Promotion
Reconciliation
```

普通页面不要直接暴露 `ReplicaKey`、`SharedAssertion`、`ReplicationStreamId` 等实现术语；诊断详情可以显示。

`Hub` 暂保留英文产品术语，必要时可展示为：

```text
Hub（多机聚合中心）
```

不要把 Hub 称为“云端”“服务器账户”，因为它可以就是用户的一台普通电脑。

## 2. 不新增“客户端 / 服务端版本”的误导

下载 / 安装层仍只有 AgentLens。

不出现：

```text
下载 Node 版
下载 Hub 版
```

而是：

```text
当前 AgentLens
[启用 Hub]
[连接到 Hub]
```

Pure Hub 是配置形态，不是第二套发行物。

## 3. Hub 启用入口

Alpha 必须让用户明确知道开启 Hub 会发生什么：

```text
启用 Hub 后：
- 本机 AgentLens 继续正常使用
- 可以接收已配对设备的同步数据
- 会启动独立的加密 Replication 网络入口
- 本机 Web 仍只在本机访问
```

如果本机采集继续开启，应明确：

```text
本机数据也会显示在这个 Hub 中
```

Pure Hub 切换应使用清晰开关：

```text
采集本机数据  [开/关]
```

而不是让用户理解 `localCapture=false`。

## 4. 连接 Hub

Node 侧至少需要：

```text
Hub 地址
Hub 身份确认
配对信息
同步策略
是否补传历史
```

推荐流程：

```text
1. 输入 / 扫描 Hub 配对信息
2. 验证 Hub 身份
3. 选择同步策略
4. 明确历史补传范围
5. 开始首次同步
```

不要把所有步骤压成一个“连接”按钮后默认执行 full history/full content。

## 5. Replication Policy 的用户表达

建议中文文案：

### 仅元数据

```text
同步会话、智能体、工具、时间、状态等结构信息，不同步提示词和工具正文。
```

### 脱敏内容

```text
同步必要正文，并再次执行脱敏和长度限制。
```

### 完整内容

```text
同步本机已允许保存的普通业务正文；已识别凭据仍会强制遮蔽。
```

首次 Pairing 不应默认隐藏当前选择。

如果没有明确产品数据支持，Alpha 默认建议使用 `metadata-only` 或 `redacted`，不要默认把 `full` 当最省事配置。

## 6. 历史补传必须单独确认

当用户从 Standalone 连接 Hub 时，界面必须说明：

```text
本机已有历史：xxx 会话 / xxx 数据量
```

并让用户选择：

```text
从现在开始同步
同步已有历史
```

如果选择已有历史，再显示当前 Replication Policy。

以后策略从 `metadata-only` 放宽为 `full` 时，也不能自动补传旧正文；再次要求明确选择。

## 7. 设备列表

Hub 至少需要一个设备视图，但不要求一定成为一级导航。

每台设备建议展示：

```text
设备名称
本机 / 远程
在线状态
AgentLens 版本
协议状态
最后同步时间
同步策略
backlog 摘要
最后错误
```

不要把 hostname 当唯一身份展示；displayName 可由用户修改，而 nodeId 只在诊断详情显示。

状态建议：

```text
已同步
首次同步中
校准中
同步延迟
需要处理
已撤销
离线
```

不要统一显示成模糊的“异常”。

## 8. Hub 总览中的“本机”

Hub 自己的数据必须有明确的“本机”标识。

例如：

```text
主力 Windows · 本机
笔记本 · 远程
Linux Server · 远程
```

用户不需要知道本机数据没有经过 Replication Client，但诊断详情可以说明 provenance。

## 9. 任务复盘中的多机筛选

Hub 上任务复盘仍保持当前 Session List / Session Detail 结构。

建议新增筛选维度：

```text
全部设备
具体设备
项目
智能体
```

设备筛选不应取代现有 Agent / Project / 时间等筛选。

Session Detail 中可以显示轻量来源：

```text
设备：主力 Windows
```

但不要把每条消息都重复标设备，避免破坏高信息密度阅读。

## 10. Project 跨机聚合

如果多个 Workspace 通过可靠 Shared Project Identity 汇聚：

```text
agent-lens
├─ 主力 Windows · D:\code\agent-lens
├─ Laptop · C:\workspace\agent-lens
└─ Linux · /home/me/agent-lens
```

这是 Hub 的核心价值之一。

UI 必须区分：

```text
项目（跨机器逻辑实体）
工作区（某台设备上的具体路径）
```

不要因为 Project Shared 就隐藏 Workspace / 路径差异。

## 11. Identity Promotion 不打扰普通用户

Node-scoped Project 后来发现可靠 Git Remote 时，Hub 内部发生 Identity Promotion。

正常成功时用户不需要确认“Replica Alias”。

只有出现冲突时才显示：

```text
项目身份冲突，需要处理
```

诊断中展示：

- 原设备；
- 原 Project；
- 新 Shared Identity；
- 冲突原因；
- 是否已自动安全合并。

Alpha 不提供“强制合并两个看起来相似项目”的快捷按钮。

## 12. 同步进度

Bootstrap 不要只显示假精确百分比。

优先展示真实指标：

```text
首次同步中
已确认 128 批
已发送 34 MB
最近成功：刚刚
仍有历史数据待处理
```

如果能够可靠估算 Entity 总量，再辅助显示百分比；不能为了 UI 好看编造总进度。

## 13. Backlog / 延迟

网络断开后：

不要显示：

```text
AgentLens 异常
```

而应显示：

```text
Hub 同步延迟
本机采集正常
待同步数据：xxx
上次成功：xx 分钟前
```

这是 Local-first 心智的重要部分。

## 14. Blocked 状态

不可重试问题至少分组展示：

```text
需要升级
身份冲突
证书 / Hub 身份变化
数据冲突
配对已撤销
```

用户界面应给明确下一动作，不要只露协议错误代码。

诊断详情再附：

```text
PROTOCOL_UNSUPPORTED
IDENTITY_NODE_CONFLICT
SHARED_MERGE_CONFLICT
...
```

## 15. 危险操作必须分开

以下动作绝不能合并成一个“删除设备”：

### 撤销连接

```text
不再允许该设备继续同步
保留 Hub 已有历史
```

### 删除该设备历史

```text
从 Hub 删除该设备的 Replica 数据
可能重新计算 Shared Project / Asset
需要影响预演和二次确认
```

### 重置本机设备身份

```text
让当前 AgentLens 成为新的 Node
本机历史保留
需要重新配对
```

### 重新同步

```text
从本机 Canonical 数据重建 / 校准 Hub Replica
不等于删除本机数据
```

文案和按钮不能混淆。

## 16. 删除历史必须预演

Hub 删除某个 Node 历史前至少显示：

```text
将删除：
- xx 会话
- xx Observation
- xx Evidence
- xx 本机资产绑定

将重新计算：
- xx Shared Project
- xx Shared Asset

不会删除：
- 其他设备的数据
- 仍由其他设备使用的 Shared Entity
```

没有预演结果时，不提供快速删除。

## 17. Hub Identity 变化

如果 Endpoint 相同但 Hub Identity 改变：

必须明确阻止同步并提示：

```text
Hub 身份发生变化
为防止数据发送到错误设备，已暂停同步。
```

不能以“这是之前那个 IP”自动接受。

如果只是 IP / hostname 变化但 Identity 不变，可以提示更新地址，不需要吓用户重新初始化全部数据。

## 18. 远程 Web 不在 Alpha 混入

Alpha Hub 页面只在 Hub 本机打开。

不要因为 Node 已经能通过 HTTPS 连 Hub，就在 UI 中增加：

```text
允许浏览器远程访问
用户名密码
共享链接
```

这是另一套安全边界。

## 19. 不提供远程控制入口

设备详情不能出现：

```text
运行 Shell
启动 Claude
安装 Skill
修改 Hook
重启远程 Agent
```

Hub 是观察与聚合，不是 Remote Management。

## 20. CLI 语义建议

CLI 具体命令实现时可调整，但语义应保持分离，例如概念上：

```text
agent-lens hub enable
agent-lens hub disable
agent-lens hub status
agent-lens hub pair
agent-lens hub revoke <device>
agent-lens hub delete-history <device> --preview

agent-lens sync connect
agent-lens sync status
agent-lens sync policy
agent-lens sync reconcile
agent-lens sync rebootstrap

agent-lens node identity
agent-lens node reset-identity
```

不建议一个：

```text
agent-lens hub reset
```

同时承担撤销、删历史、重配对和身份重置。

## 21. UI 信息架构暂不锁死

Hub Alpha 需要这些功能面：

- Hub 开关 / 身份状态；
- 设备列表；
- Pairing；
- Replication Policy；
- 同步状态 / backlog / diagnostics；
- Node / Host 筛选；
- 删除 / 撤销 / 重同步操作。

但本文不强制它们必须：

- 新增第六个一级导航；
- 全放“设置”；
- 全放“状态页”。

等正式高保真原型时再根据现有五个一级页面与状态入口决定布局，避免架构文档提前锁死表现层。

## 22. Alpha UX 验收

至少验证：

- 用户能理解“Hub 离线不影响本机采集”；
- 用户能明确选择是否补传历史；
- 用户能看见当前 Replication Policy；
- `full` 不会被模糊文案伪装成普通默认同步；
- 设备 offline / degraded / blocked 有不同语义；
- 撤销和删除历史是两个不同动作；
- 删除历史前有影响预演；
- Hub Identity 改变会阻止继续发送；
- Project / Workspace 的跨机器关系可理解；
- 页面不暴露大量 ReplicaKey / StreamId 实现术语；
- 不出现远程执行入口；
- 不为了 Hub 破坏当前任务复盘的高信息密度阅读结构。
