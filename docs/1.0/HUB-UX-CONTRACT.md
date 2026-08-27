# AgentLens 1.0 Hub UX Contract

更新日期：2026-08-27  
状态：Alpha 产品交互设计约束，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-OPERATIONS.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`
- `docs/1.0/CAPTURE-POLICY.md`

本文定义 Hub 在 Web / Desktop / CLI 中必须表达清楚的产品语义，不锁死具体页面布局。

## 1. 用户术语

面向用户优先：设备、Hub（多机聚合中心）、本机、远程设备、同步、同步策略、历史范围、首次同步、同步校准、同步暂停、撤销连接、删除历史。

内部可以使用 Node、Replication Stream、Replica Generation、Replica Key、Shared Group / Membership、Identity Promotion、Reconciliation。普通页面不暴露这些实现术语。

不要把 Hub 称为“云端”“服务器账户”。

## 2. 不新增 Node / Hub 两套发行物

下载层仍只有 AgentLens。用户看到“启用 Hub / 连接到 Hub”；Pure Hub 是配置形态，不是第二套程序。

## 3. Capability Profile 对用户简单、配置严格

用户只理解：本机使用、连接到 Hub、作为 Hub、Pure Hub。

Alpha 不允许同一实例同时连接上游 Hub并接收下游 Node；从“连接 Hub”切“作为 Hub”时先断开 / 冻结 upstream relationship。

## 4. 启用 Hub

开启前说明：本机 AgentLens 继续正常；可以接收已配对设备；会启动独立加密 Replication 网络入口；本机 Web 仍只本机访问。

Hub 本机采集开启时说明“本机数据也会显示在这个 Hub 中”。Pure Hub 用“采集本机数据”开关表达。

## 5. 连接 Hub

流程至少包括 Hub 地址、Hub 身份确认、配对信息、同步策略、历史范围：

```text
1. 输入 / 扫描 Hub 配对信息
2. 验证 Hub 身份
3. 选择同步策略
4. 选择历史范围
5. 完成配对
6. 验证 Hub 长期身份
7. 首次同步 / 建立 from-now Boundary
```

不能一个“连接”按钮默认 full content + full history。

## 6. 同步策略

### 仅元数据

```text
不同步提示词和工具正文，也默认不发送完整本机路径；仍会同步会话结构、智能体 / 工具、时间以及用于项目聚合的项目 / 仓库标识等元数据。
```

仅元数据不是匿名模式，不能写“不会上传敏感信息”。

### 脱敏内容

同步必要正文 / 路径信息，再执行凭据遮蔽、路径脱敏与限长。

### 完整内容

同步本机已允许保存的普通业务正文和必要本机路径；明确凭据仍强制遮蔽。

Alpha 默认建议 metadata-only 或 redacted，不默认 full。

## 7. History Scope 与 Policy 分开

```text
同步策略：传什么
历史范围：是否补已有历史
```

### 从现在开始

不主动补传 Boundary 建立前的旧任务正文；之后的新事实正常同步，并可能携带项目、会话等结构依赖。

### 包含已有历史

按当前 Policy 补传本机既有历史。

from-now 是持久边界；Reconciliation 不能绕过。

## 8. 历史补传单独确认

首次连接尽量显示已有会话 / 数据量估算，并让用户明确选择“从现在开始 / 同步已有历史”。Policy 放宽时也再次区分“仅未来 / 补传既有历史”。

## 9. Policy 收紧立即生效

full -> metadata-only 保存后，产品语义是“不再继续发新的 full 内容”。如果旧 Batch 可能已提交但 ACK 丢失，不能偷偷重发旧正文维持 sequence。

UI 可显示：

```text
同步已暂停，正在安全切换同步策略
本机采集正常
```

旧 Hub 完整内容不会自动 Purge，清理由独立操作完成。

## 10. 设备列表

建议：设备名称、本机/远程、在线状态、AgentLens 版本、协议状态、最后同步、Policy、History Scope、backlog、最后错误。

状态：已同步、首次同步中、校准中、同步延迟、同步已暂停、需要处理、已撤销、离线。

hostname 不是唯一身份；nodeId 只在诊断中显示。

## 11. Hub 本机

明确显示“主力 Windows · 本机”。本机 Project / Asset 与 Remote 一样参与 Shared Group 聚合，但用户不需要知道它没有走 HTTPS 自我复制。

## 12. 任务复盘多机筛选

保留 Session List / Session Detail；新增全部设备 / 具体设备 / 项目 / 智能体等筛选。详情轻量显示设备，不在每条消息重复。

## 13. Project / Workspace 跨机表达

用户看到的“项目”是 Shared Project Group 的产品视图，不是要求数据库里所有 Workspace 共用一个 Project 主键。

```text
agent-lens
├─ 主力 Windows · D:\code\agent-lens
├─ Laptop · C:\workspace\agent-lens
└─ Linux · /home/me/agent-lens
```

Policy 隐藏路径时改成“工作区路径已隐藏”。

产品语义：

```text
项目 = 可靠 Portable Identity 汇聚出的跨设备逻辑项目
工作区 = 某台设备的具体环境
```

必须保留设备 / Workspace 差异。普通 UI 不显示 SharedGroupKey。

## 14. Identity Promotion 不打扰普通用户

某个本地 Project 后来发现可靠 Git Remote 时，内部只是让该 origin Project **加入对应 Shared Project Group**。成功无需弹“合并主键 / Alias”之类实现提示，也不会让用户看到 Workspace 路径归属突然改变。

只有身份冲突才显示“项目身份冲突，需要处理”。Alpha 不提供按名字/路径强制合并。

## 15. Bootstrap 进度

不编造精确百分比。优先显示已确认批次、已发送字节、最近成功、是否仍有历史待处理；只有可靠估算总量后才显示百分比。

## 16. Re-bootstrap 不暴露半成品

```text
当前数据仍可查看
正在构建新的同步副本
```

新 Generation 完成 + 校准前不替换现有查询。失败显示“现有 Hub 历史未受影响”。

对 Shared Project / Asset 也同样：新 Generation 的 Membership 未激活前，用户继续看到旧 active Group 结果，不出现项目成员忽隐忽现。

## 17. Backlog / 延迟

网络断开显示“Hub 同步延迟 / 本机采集正常 / 待同步数据 / 上次成功”，不是“AgentLens 异常”。

## 18. Paused / Blocked

Paused = 用户/安全策略主动暂停；Blocked = 需要升级、身份冲突、Hub 身份变化、数据冲突、撤销、Clock Skew、Hub 存储不足等不可重试问题。

普通 UI 给中文动作，诊断再显示错误码。

## 19. 跨机器时间

不暗示两台设备相差几百毫秒就证明绝对先后。保留来源事件时间；Clock Skew 可提示；replicatedAt 不冒充 occurredAt；跨机排序只是可重复 best-effort。

## 20. 危险操作分开

- 撤销连接：阻止未来同步，保留历史；
- 删除设备历史：删除该设备 origin replica，并撤回该设备 Shared Membership / Assertions，必须预演；
- 重置本机设备身份：生成新 Node Identity，本机历史保留，需要 Re-pair；
- 同步校准：查漏补缺，不删库；
- 重新构建 Hub 数据：建立 staged Replica Generation，完成前保留现有查询。

不能一个“重置”按钮包办。

## 21. 删除历史预演

至少显示：将删除多少 Session / Observation / Evidence / 本机资产绑定；将撤回多少 Shared Project / Asset Membership；哪些 Shared Group 会重新计算；不会删除其他设备 origin 数据或仍有其他 members 的 Shared Group。

## 22. Hub Identity 变化

同 endpoint 但 Hub Identity / serverProof 改变时暂停同步，明确提示“Hub 身份发生变化”。IP/hostname 变化但 Hub Identity 不变只视为连接信息变化。

## 23. Headless Pure Hub

Alpha Local Web 仍 loopback，不内建 Remote Web Login。Linux/NAS 用 SSH CLI、OS 远程会话或用户自建可信 tunnel 管理。

## 24. 不提供远程控制

设备详情不出现 Shell、启动 Agent、安装 Skill、修改 Hook、重启远程 Agent 等操作。

## 25. CLI 语义建议

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

Stream Rollover 默认由安全状态机处理，可放 advanced diagnostics，不作为普通命令。

## 26. UI 信息架构暂不锁死

需要 Hub Identity/开关、设备列表、Pairing、Policy/History Scope、同步状态、Node/Host 筛选、危险操作，但不强制新增第六个一级导航。

## 27. Alpha UX 验收

- 用户理解 Hub 离线不影响本机采集；
- Policy / History Scope 分开；
- metadata-only 不宣传匿名；
- 用户明确选择是否补历史；
- Policy 收紧立即停止新的旧策略出站；
- offline/degraded/paused/blocked 可区分；
- Project = 跨设备逻辑 Group，Workspace = origin 环境；
- Promotion 不造成可见 FK / Workspace 归属跳变；
- Re-bootstrap 失败不让现有历史 / Shared Group 消失；
- revoke / delete / reconcile / rebootstrap / reset identity 分开；
- 删除历史有 Membership 影响预演；
- Hub Identity 变化阻止继续发送；
- Clock Skew 不解释为精确因果；
- 普通页面不暴露 ReplicaKey / StreamId / SharedGroupKey；
- 无 Remote Execution；
- 不破坏当前任务复盘高信息密度。
