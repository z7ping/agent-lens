# AgentLens 1.0 Hub 运维与生命周期

更新日期：2026-08-27  
状态：**Alpha 运维设计冻结，尚未实现**  
上位设计：`docs/1.0/HUB-DESIGN.md`  
安全边界：`docs/1.0/HUB-PAIRING-SECURITY.md`

本文只记录 Hub 的真实使用生命周期、状态表达与高风险操作边界，不重复 Replication 数据模型或 Wire 结构。

## 1. 四种使用形态

用户层只需要理解：

```text
本机使用
连接到 Hub
作为 Hub
Pure Hub
```

底层仍是同一个 AgentLens Runtime / 数据根 / 发行物。

从“连接到 Hub”切到“作为 Hub”前必须先断开 / 冻结 upstream relationship；Alpha 不允许级联 Hub。

## 2. 启用 Hub

启用 `hubAccept`：

- 保留现有 Local Canonical / Web；
- 新增独立 Replication HTTPS Surface；
- 初始化 Hub Identity 与 Replication Control Plane；
- 默认仍可采集本机；
- 初始化失败不得破坏 Standalone 本地能力。

关闭 Hub 接收能力：

```text
stop Replication Surface
 -> pause/freeze downstream operationally
 -> preserve Remote Replica / Trust / Shared State
 -> Local Web / Local Canonical continue
```

**Disable Hub 不等于删除远程历史。**

## 3. Hub 与 Pure Hub

Hub 本机也是一个 Node origin，但不走 HTTPS 自我复制。

切成 Pure Hub 只停止未来本机 Source / Capture：

- 已有 Hub Local Canonical 历史继续可查；
- 已有 Hub Local Shared Project / Asset Membership 继续参与聚合；
- 不自动删除或隐藏旧本机数据。

**Pure Hub 不等于清空本机历史。**

## 4. 连接 Hub

用户流程至少表达：

```text
1. Hub endpoint / 配对信息
2. 验证 Hub 身份
3. 选择 Replication Policy
4. 选择 History Scope
5. Pair
6. 验证长期 Hub Identity
7. Bootstrap 或建立 from-now Boundary
8. Reconcile
9. Incremental
```

不能用一个“连接”按钮默认授权 full + all history。

Hub 拒绝 self-pair。

## 5. Policy 与 History Scope

用户必须分开理解：

```text
同步策略 = 传什么
历史范围 = 是否补已有历史
```

Policy：

```text
仅元数据
脱敏内容
完整内容
```

History：

```text
从现在开始
包含已有历史
```

`metadata-only` 不能写成“匿名”或“不会上传敏感信息”；它仍可能发送 Repository Identity、Agent/Tool、时间与结构元数据。

## 6. from-now

“从现在开始”建立持久 History Boundary：

- 不普通补传 Boundary 前旧 Observation / Prompt / Tool 正文；
- Reconciliation 不能绕过；
- Boundary 后新事实可携带必要的旧 identity / FK dependency；
- Dependency 只发送 Minimum Shape，不顺带补旧 title / full path / old body。

## 7. Bootstrap / Reconcile / Re-bootstrap

`include-existing`：

```text
Bootstrap
 -> Mandatory Reconciliation
 -> Incremental
```

Bootstrap 可中断恢复，期间本地采集继续。

Re-bootstrap 使用 staged Replica Generation：

```text
G1 active
 -> G2 staged
 -> bootstrap
 -> reconcile
 -> validate
 -> atomic activate G2
 -> retire G1
```

G2 未完成时现有 Hub 查询继续使用 G1，不向用户暴露半成品 Shared Project / AgentProduct 聚合。

## 8. 同步状态

用户可见状态至少区分：

```text
未连接
配对中
首次同步
校准中
已同步
同步延迟
已暂停
需要处理
已撤销
离线
```

Hub 故障、backlog 或 Protocol 不兼容必须同时表达：

> 本机采集仍正常。

不能把 Replication degraded 显示成整个 AgentLens 失败。

## 9. Backlog 与 Node 本地磁盘压力

Hub 不可达时：

- Local Canonical 正常写入；
- 普通 pending 优先依靠 Canonical Reconciliation 重建；
- 已经可能提交的 immutable Batch 必须保留 exact retry Body；
- Tombstone、History Boundary、Policy / History Revision、Stream / ACK 等关键状态不可因空间不足丢弃。

Replication state 达到容量阈值时：

```text
pause replication
 -> report storage pressure
 -> keep local capture
 -> resume + reconcile after recovery
```

不得删除 Local Canonical Fact 给同步状态腾空间。

## 10. Hub 写入压力

Remote Bootstrap / Reconcile / backlog catch-up 使用有界队列、并发限制、小事务与 backpressure。

Remote Import 不能长期占用 SQLite writer，饿死 Hub 本机 Canonical Commit。

压力时可以返回 `SERVER_BUSY / SERVER_STORAGE_PRESSURE` 并降速；Local-first 本机采集优先可用。

## 11. Policy 收紧 / 放宽

### 收紧

例如 full -> metadata-only：

- 立即停止新的旧 Policy 出站；
- 未发送 pending 按新 Policy 重算；
- 已 ACK 的旧内容不自动 Purge；
- ambiguous 旧 Batch 不允许为填 sequence gap 重发敏感正文；
- 必要时执行 authenticated Stream Rollover + Reconcile。

### 放宽

metadata-only -> full 时继续询问：

```text
只对未来生效
还是
补传已有历史
```

Policy 放宽不能隐式扩大 History Scope。

## 12. 离线与升级

Hub 离线：Node Local Capture / Web 正常，Replication backoff。

Node 离线：Hub 已有历史继续可查；offline 不等于 delete；Hub 不反向探测 / 控制 Node。

推荐升级：

```text
Hub first
 -> verify old Protocol / Entity Versions
 -> rolling Node upgrades
```

协议不兼容只阻塞同步。

## 13. Re-pair / Revoke / Delete / Reset

这些必须是不同操作：

### Re-pair

重建安全 Relationship，通常新 Stream；nodeId 未变则 ReplicaKey 不变。

### Revoke

阻止未来上传，默认保留历史、assertions / memberships。

### Delete Node History

必须先 preview，再按 originNodeId 删除该 Node Remote Replica、撤回其 assertions / memberships、重算 Groups；不能影响其他 Node / Hub Local origin。

### Reset Node Identity

生成新 nodeId + Node Key，清 upstream relationship / stream，保留 Local Canonical。重新连原 Hub 会形成新的 Replica Namespace；Alpha 不自动跨 nodeId dedup。

## 14. 删除与 Purge

普通 scan absence 不等于删除。正式删除由 Tombstone / 显式历史删除表达。

Policy Setting Change 不自动 Purge 已经在 Hub 存在的旧 full 内容。

需要清除历史敏感内容时，使用独立显式 Purge / Delete 操作。

## 15. Remote Asset 与本机资产备份

Hub 可以展示 Remote Asset / AssetBinding，但这不代表远程文件存在于 Hub 文件系统。

现有资产备份只能处理 Hub 本机真正可访问、由本机 Source / Asset Inventory 发现的文件。

禁止：

- 用 Remote `AssetBinding.path` 在 Hub 本机 `readFile/copy/hash`；
- 因路径字符串恰好相同就判定远程文件可访问；
- 把“同步了 Remote Asset metadata”展示成“已备份远程资产文件”。

Alpha 不做 Remote File Backup / Pull。

## 16. Project / Workspace 用户语义

跨机视图：

```text
项目   = 可靠 Portable Identity 聚合出的逻辑项目
工作区 = 某台设备上的具体环境
```

示意：

```text
agent-lens
├─ 主力 Windows · D:\code\agent-lens
├─ Laptop · C:\workspace\agent-lens
└─ Linux · /home/me/agent-lens
```

Policy 隐藏路径时显示“工作区路径已隐藏”，不能用假路径。

普通 UI 不暴露 ReplicaKey / StreamId / SharedGroupKey。

## 17. 任务复盘与多机筛选

保持现有高信息密度任务复盘，不因为 Hub 重做交互模型。

新增的多机语义主要是：

- 全部设备 / 具体设备；
- Shared Project；
- Agent / Host filter；
- 详情中轻量显示来源设备。

Remote omitted / redacted 内容必须明确显示“未同步 / 已隐藏”，不能展示为空内容。

## 18. 危险操作 UX

以下操作不能合并成一个“重置”：

- 撤销连接；
- 删除设备历史；
- 重置本机设备身份；
- 同步校准；
- 重新构建 Hub Replica；
- Purge 已同步敏感内容。

删除设备历史必须预演影响：Remote Session / Observation / Evidence 数量、Shared Membership / Assertion 变化，以及明确“不删除其他设备数据”。

## 19. Headless Hub

Alpha 不开放 Remote Web Login。

NAS / Linux Server 管理方式：

- 本机 CLI；
- SSH 后执行 CLI；
- OS Remote Session；
- 用户自建可信 loopback tunnel。

不能因此把现有 `127.0.0.1:56789` Local Web 改成无认证网络监听。

## 20. Hub / Node 数据丢失

Hub Remote Replica 通常可以由 Nodes Re-bootstrap，但 Hub Identity、Pairing Trust、Stream / Receipt、Tombstone 等安全 / Control Plane 状态有独立恢复边界。

Node 本地数据丢失时，Hub 不是默认灾备恢复源；Alpha 不做 Hub -> Node Canonical restore。

## 21. Alpha 运维冻结不变量

- Standalone 开启 Hub 后本机历史 / Web 不变化；
- Hub 拒绝 self-pair；
- Pure Hub 不启动 Source，但已有 Local 历史继续可查；
- Disable Hub 不删除 Remote Replica / Trust；
- include-existing Bootstrap 可恢复；
- from-now 不泄露 Boundary 前非必要字段；
- backlog storage pressure 不伤 Local Canonical；
- Protocol / Entity Version 不兼容只阻塞同步；
- Policy 收紧 ambiguous Batch 可安全 Rollover；
- staged Re-bootstrap 失败不影响 active 数据；
- Revoke 不删历史；Delete 只删目标 Node origin；
- Remote Asset 不被本机资产备份误读；
- Remote Import 压力不饿死本机 Canonical Commit；
- Replication 状态 / 错误不进入 Canonical Observation；
- npm / Desktop 切换 Daemon owner 不改变 Node / Hub Relationship。

## 22. 当前非目标

HA / Federation、云账号、Remote Execution、Hub -> Node Restore、Remote File Backup、模糊跨 Node Identity、自动 Repository Rebind 历史迁移、内建 Remote Web 用户认证。
