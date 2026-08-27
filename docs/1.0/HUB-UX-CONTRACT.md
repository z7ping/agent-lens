# AgentLens 1.0 Hub UX Contract

更新日期：2026-08-27  
状态：Alpha 产品交互设计约束，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-OPERATIONS.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`
- `docs/1.0/CAPTURE-POLICY.md`

本文定义 Hub 在 Web / Desktop / CLI 中必须表达清楚的产品语义，不锁死具体页面布局，也不要求新增一级导航。

## 1. 用户术语

面向用户优先：

```text
设备
Hub（多机聚合中心）
本机
远程设备
同步
同步策略
历史范围
首次同步
同步校准
同步暂停
撤销连接
删除历史
```

内部可以继续使用：

```text
Node
Replication Stream
Replica Generation
Replica Key
Shared Assertion
Identity Promotion
Reconciliation
```

普通页面不暴露实现术语；诊断详情可以显示。

不要称 Hub 为“云端”“服务器账户”，因为它可以就是普通电脑。

## 2. 不新增 Node / Hub 两套发行物

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

Pure Hub 是配置形态。

## 3. Capability Profile 对用户简单，对配置严格

用户不需要理解三个布尔字段，但产品只能形成四个合法形态：

```text
本机使用
连接到 Hub
作为 Hub
Pure Hub
```

Alpha 不允许同一实例同时：

```text
连接上游 Hub
+
接收下游 Node
```

如果用户从“连接到 Hub”切换“作为 Hub”，界面必须先提示断开 / 冻结当前 upstream relationship。

## 4. 启用 Hub

开启前说明：

```text
- 本机 AgentLens 继续正常使用
- 可以接收已配对设备的数据
- 会启动独立加密 Replication 网络入口
- 本机 Web 仍只在本机访问
```

本机采集开启时：

```text
本机数据也会显示在这个 Hub 中
```

Pure Hub：

```text
采集本机数据 [开/关]
```

不要暴露 `localCapture=false`。

## 5. 连接 Hub 的流程

Node 侧至少需要：

```text
Hub 地址
Hub 身份确认
配对信息
同步策略
历史范围
```

推荐：

```text
1. 输入 / 扫描 Hub 配对信息
2. 验证 Hub 身份
3. 选择同步策略
4. 选择历史范围
5. 完成配对
6. 验证 Hub 长期身份
7. 开始首次同步 / 建立从现在开始的边界
```

不能一个“连接”按钮默认执行 full content + full history。

## 6. 同步策略的准确用户表达

### 仅元数据

建议文案：

```text
不同步提示词和工具正文，也默认不发送完整本机路径；仍会同步会话结构、智能体 / 工具、时间以及用于项目聚合的项目 / 仓库标识等元数据。
```

重要：**仅元数据不是匿名模式。**

不能写成：

```text
不会上传敏感信息
```

因为项目 / 仓库名称、工具使用模式、时间结构本身也可能敏感。

### 脱敏内容

```text
同步必要正文和必要路径信息，并再次执行凭据遮蔽、路径脱敏与长度限制。
```

### 完整内容

```text
同步本机已允许保存的普通业务正文和必要本机路径；已识别凭据仍会强制遮蔽。
```

Alpha 默认建议 `metadata-only` 或 `redacted`，不默认 `full`。

## 7. 历史范围与同步策略必须分开

用户分别选择：

```text
同步策略：传什么
历史范围：传多久以前的数据
```

历史范围：

### 从现在开始

```text
不主动补传当前已有的旧任务正文；之后产生的新事实正常同步，并可能同步它们所需的项目、会话等结构依赖。
```

### 包含已有历史

```text
按当前同步策略补传本机已经存在的历史数据。
```

“从现在开始”必须是持久边界；后续“同步校准”不能偷偷把旧历史补上。

## 8. 历史补传必须单独确认

首次连接时尽量显示：

```text
本机已有：xx 会话 / 估算 xx MB
```

让用户明确选：

```text
从现在开始
同步已有历史
```

以后 `metadata-only -> full` 时也再次区分：

```text
仅未来使用完整内容
补传既有历史的完整内容
```

## 9. Policy 收紧应立即让用户有安全感

例如：

```text
full -> metadata-only
```

用户保存后，产品语义是：

> 不再继续发出新的 full 内容。

如果存在一个“可能已发到 Hub、但 ACK 丢失”的旧 Batch，不能后台偷偷重发旧正文来维持 sequence。

UI 可显示：

```text
同步已暂停，正在安全切换同步策略
本机采集正常
```

底层通过 Stream Rollover / Reconcile 恢复；普通用户不需要理解 Stream ID。

同时说明：

> 已经同步到 Hub 的旧完整内容不会自动删除，如需清理请执行独立历史清理。

## 10. 设备列表

每台设备建议展示：

```text
设备名称
本机 / 远程
在线状态
AgentLens 版本
协议状态
最后同步时间
同步策略
历史范围
backlog 摘要
最后错误
```

不要把 hostname 当唯一身份。nodeId 只在诊断中显示。

状态建议：

```text
已同步
首次同步中
校准中
同步延迟
同步已暂停
需要处理
已撤销
离线
```

## 11. Hub 本机

Hub 本机明确显示：

```text
主力 Windows · 本机
```

本机 Project / Asset 也必须参与 Shared Identity 聚合。

用户不需要知道本机没有经过 HTTPS 自我复制。

## 12. 任务复盘的多机筛选

继续保持 Session List / Session Detail。

新增可用筛选：

```text
全部设备
具体设备
项目
智能体
```

Session Detail 可轻量显示：

```text
设备：主力 Windows
```

不要每条消息重复设备标签。

## 13. Project / Workspace 跨机表达

可靠 Shared Project：

```text
agent-lens
├─ 主力 Windows · D:\code\agent-lens
├─ Laptop · C:\workspace\agent-lens
└─ Linux · /home/me/agent-lens
```

但当 Policy 隐藏路径时：

```text
agent-lens
├─ 主力 Windows · 工作区路径已隐藏
├─ Laptop · 工作区路径已隐藏
└─ Linux · 工作区路径已隐藏
```

项目 = 跨机器逻辑身份；工作区 = 某台设备的具体环境。

不要为了 Shared Project 隐藏设备差异。

## 14. Identity Promotion 不打扰普通用户

安全 Promotion / Shared Membership 成功时无需提示内部 Alias。

冲突才显示：

```text
项目身份冲突，需要处理
```

Alpha 不提供“强制合并两个看起来相似项目”。

## 15. Bootstrap 进度

不要编造精确百分比。

优先真实指标：

```text
首次同步中
已确认 128 批
已发送 34 MB
最近成功：刚刚
仍有历史数据待处理
```

可靠估算总量后才能辅助百分比。

## 16. Re-bootstrap 不能让用户看到半成品

显式“重新构建 Hub 数据”时：

```text
当前数据仍可查看
正在构建新的同步副本
```

新 Replica Generation 完成 + 校准前，不替换当前可查询数据。

失败时：

```text
重新构建失败
现有 Hub 历史未受影响
```

不能让用户在半完成阶段看到大量会话突然消失。

## 17. Backlog / 延迟

网络断开：

```text
Hub 同步延迟
本机采集正常
待同步数据：xx
上次成功：xx 分钟前
```

不是：

```text
AgentLens 异常
```

## 18. Blocked / Paused 区分

### 已暂停

用户 / 安全策略主动暂停，通常可以明确继续动作。

### 需要处理

不可重试问题，例如：

```text
需要升级
身份冲突
Hub 身份变化
数据冲突
配对已撤销
系统时间偏差过大
Hub 存储空间不足
```

普通 UI 给中文动作；诊断再显示稳定错误码。

## 19. 跨机器时间语义

多台电脑时钟可能有偏差。

UI 不应该暗示：

> 两台设备显示相差 200ms 就能证明绝对先后。

原则：

- 保留来源事件时间；
- Clock Skew 明显时可以提示；
- 不显示“Hub 收到时间”冒充事件发生时间；
- 跨机排序是可重复的 best-effort，不自动推断跨机因果。

## 20. 危险操作必须分开

### 撤销连接

```text
阻止未来同步
保留已有历史
```

### 删除设备历史

```text
从 Hub 删除该设备 Replica
重新计算 Shared Project / Asset
必须预演
```

### 重置本机设备身份

```text
生成新 Node Identity
本机历史保留
需要重新配对
在同一 Hub 中可能与旧 Node 历史同时存在
```

### 同步校准

```text
从 Local Canonical 状态查漏补缺
不删库
```

### 重新构建 Hub 数据

```text
构建新的 Replica Generation
完成前保留现有查询数据
```

不能用一个“重置”按钮承担所有语义。

## 21. 删除历史预演

至少显示：

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
- 其他设备数据
- 仍由其他设备使用的 Shared Entity
```

没有预演不提供快速删除。

## 22. Hub Identity 变化

同 endpoint 但 Hub Identity / server proof 变化：

```text
Hub 身份发生变化
为防止数据发送到错误设备，已暂停同步。
```

IP / hostname 改变但 Hub Identity 不变则是连接信息变化，不自动当成新 Hub。

## 23. Headless Pure Hub

Alpha 本机 Web 仍 loopback，不内建 Remote Web Login。

Pure Hub 在 Linux / NAS 上可通过：

- SSH CLI；
- OS 远程会话；
- 用户自己建立可信 tunnel 访问 loopback Web。

文档不要宣传“启用 Hub 后直接从任意浏览器访问管理页”。

## 24. 不提供远程控制入口

设备详情不能出现：

```text
运行 Shell
启动 Claude
安装 Skill
修改 Hook
重启远程 Agent
```

Hub 是观察与聚合。

## 25. CLI 语义建议

概念命令可以调整，但操作必须分离：

```text
agent-lens hub enable|disable|status
agent-lens hub pair
agent-lens hub revoke <device>
agent-lens hub delete-history <device> --preview

agent-lens sync connect
agent-lens sync status
agent-lens sync policy
agent-lens sync history
agent-lens sync reconcile
agent-lens sync rebootstrap

agent-lens node identity
agent-lens node reset-identity
```

底层 Stream Rollover 通常由安全状态机自动完成，可在 doctor / advanced diagnostics 暴露，不必成为普通用户常用命令。

## 26. UI 信息架构暂不锁死

需要功能面：

- Hub 开关 / 身份；
- 设备列表；
- Pairing；
- Policy / History Scope；
- 同步状态 / backlog / paused / blocked；
- Node / Host 筛选；
- 删除 / 撤销 / Reconcile / Re-bootstrap。

但不强制新增第六个一级导航。等高保真阶段再决定。

## 27. Alpha UX 验收

至少验证：

- 用户理解 Hub 离线不影响本机采集；
- Policy 与 History Scope 是两个选择；
- metadata-only 不被宣传成匿名模式；
- metadata-only 默认不显示 / 上传完整 Workspace 路径；
- 用户明确选择是否补传历史；
- full -> metadata-only 立即停止新的 full 出站；
- offline / degraded / paused / blocked 语义不同；
- 撤销和删除历史分开；
- Reconcile 和 Re-bootstrap 分开；
- Re-bootstrap 失败不让现有 Hub 历史消失；
- 删除历史有影响预演；
- Hub Identity 改变会阻止继续发送；
- Project / Workspace 跨机关系可理解；
- Clock Skew 不被 UI 解释成精确因果顺序；
- 页面不暴露大量 ReplicaKey / StreamId；
- 不出现 Remote Execution；
- 不破坏当前任务复盘高信息密度。
