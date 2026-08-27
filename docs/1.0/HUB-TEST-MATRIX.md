# AgentLens 1.0 Hub Alpha 测试矩阵

更新日期：2026-08-27  
状态：测试设计，尚未实现  
目的：把 ADR 与 Hub Contract 中的架构不变量转成可执行验收清单，避免实现后只验证 happy path。

相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-OPERATIONS.md`
- `docs/1.0/HUB-UX-CONTRACT.md`

## 1. 测试层级

```text
L1 Unit
L2 Contract
L3 Storage Integration
L4 In-process Replication E2E
L5 HTTPS / Pairing E2E
L6 Cross-platform
L7 Failure Injection
L8 Performance / Soak
L9 Real-machine Dogfood
```

原则：核心身份 / Merge / Protocol 语义必须在 L1-L4 可稳定验证，不允许所有问题都依赖三台真实机器手工复现。

## 2. Standalone 回归

| 场景 | 期望 |
| --- | --- |
| 没有任何 Hub 配置启动 | 行为与当前 1.0 一致 |
| 没有 replication plugin active | Source / Canonical / Web 正常 |
| Hub 配置损坏但 replicationUpstream=false | 不影响本机启动 |
| Replication 网络错误 | 不影响 Source / Observation Commit |
| Desktop / npm 共存 | 仍只有一个默认 Daemon / 数据根 |

这是所有 Hub 阶段持续必跑门禁。

## 3. Node Identity

| 场景 | 期望 |
| --- | --- |
| 首次初始化 | 生成 nodeId |
| 重启 | nodeId 不变 |
| 改 hostname | nodeId 不变 |
| AgentLens 升级 | nodeId 不变 |
| 删除 node identity 并显式 reset | 生成新 nodeId |
| 复制整个数据根到另一台机器并同时运行 | Hub 检测 identity conflict，不静默合并 |
| 同 hostname/platform/arch 两台机器 | nodeId 不同 |

## 4. Capability Composition

| 配置 | Source | Upstream Client | Hub Accept |
| --- | --- | --- | --- |
| Standalone | 开 | 关 | 关 |
| 普通接入节点 | 开 | 开 | 关 |
| Hub | 开 | 关 | 开 |
| Pure Hub | 关 | 关 | 开 |

验证 Pure Hub 不执行 Detect / History / Runtime / Asset。

## 5. Replica Key

必须覆盖：

- 相同 Node + type + originId -> 永远同 ReplicaKey；
- 不同 Node + 同 originId -> 不同 ReplicaKey；
- EntityType 不同 + 同 originId -> 不同 ReplicaKey；
- Hub 重新计算与 Node 提供值不一致 -> 拒绝；
- Node 本机 ID 格式变化不能让 Hub 通过字符串猜 Scope。

## 6. Entity Scope

### Shared

- AgentProduct 相同 productId 汇聚；
- 展示字段差异按 deterministic merge；
- merge 结果与到达顺序无关。

### Conditional Shared / Project

- 只有 `D:\foo` 与 `/home/foo` -> 不合并；
- HTTPS / SSH 同一 GitHub remote -> Normalize 后合并；
- remote 含 userinfo / credential -> identity 去掉凭据；
- query / fragment 不参与 identity；
- 不同 repo path -> 不合并。

### Conditional Shared / AssetDefinition

- 两个都叫 `review` 但无 portable upstream identity -> 不合并；
- 同 portable upstream identity -> 合并；
- 本机绝对路径不能作为 Shared Identity；
- invariant canonicalName 冲突 -> conflict。

### ToolDefinition

- 两 Node 都有 `Read` -> 仍保持 Node-scoped；
- schemaHash 不同 -> 不提前合并。

## 7. Typed EntityRef

覆盖：

- node ref 正确解析 ReplicaKey；
- shared ref 正确解析 SharedKey；
- 缺 scope -> reject；
- shared type 却发送 node-only 字段 -> reject；
- node ref 指向另一个 Node -> Alpha reject；
- 缺必须依赖 -> Batch rollback；
- Coverage subjectRef 可以引用 shared / node scoped；
- payload 中出现 `session-xxx` 字符串不被改写。

## 8. Dependency DAG

覆盖：

- DTO 数组随机顺序仍得到同样导入结果；
- Host -> Installation -> Session -> Observation FK 完整；
- Actor parent DAG 正常；
- Actor parent cycle -> reject；
- SessionRelationship 缺一端 -> reject；
- Observation 引用缺 Evidence / Session -> reject；
- 任一阶段失败整个 Batch rollback。

## 9. Shared Merge

每个 Shared Contract 验证：

```text
commutative
associative（在定义范围内）
idempotent
arrival-order independent
```

Project：

- createdAt -> min；
- lastSeenAt -> max；
- name 差异只 diagnostics；
- repositoryIdentity invariant。

Shared Assertion：

- A/B 两来源同一 Project -> 1 Shared Row + 2 assertions；
- A 更新 metadata -> recompute；
- A withdrawal -> B 仍存在，Shared Row 保留；
- 全部 withdrawal + 无引用 -> eligible for GC。

## 10. Identity Promotion

覆盖：

- path-only Project 后同 Workspace 发现 Git Remote -> promotion；
- promotion 事务内重写声明式 FK；
- old ReplicaKey -> permanent alias；
- promotion 后旧 Batch 重试 -> 仍解析 SharedKey；
- 重复 promotion -> idempotent；
- 同 origin promote 到 Shared A 后再到 B -> conflict；
- Hub 根据 name/path 相似度不能自行 promotion；
- shared Project remote 改变 -> 不按 promotion 处理；
- Asset 无强证据 -> 不 promotion。

## 11. Replication Policy

### metadata-only

- Prompt / Tool 正文不出站；
- Session / Tool Usage 所需结构可用；
- Raw SourceRecord payload 不偷带正文。

### redacted

- 再次执行出站脱敏；
- 凭据仍强制遮蔽；
- 长度限制有效。

### full

- 只复制本机已保存普通正文；
- Capture off 数据无法恢复；
- 明确凭据仍遮蔽。

### 状态语义

- original null；
- omitted by policy；
- not captured；
- redacted；

四者在 Hub 可区分。

## 12. Policy 变更

- full -> metadata-only：后续收紧，不自动清 Hub 历史；
- metadata-only -> full：不确认历史补传时只影响未来；
- 用户确认历史补传 -> Bootstrap / Reconcile 补齐允许内容；
- policy 变化过程中 backlog 存在 -> 不混淆旧/新出站语义；
- Batch 声明 policy 与实际字段状态矛盾 -> reject / diagnostics。

## 13. Protocol Handshake

覆盖：

- R1.0 Node + R1.2 Hub -> 选共同最高 minor；
- R1 only + R2 only -> PROTOCOL_UNSUPPORTED；
- unsupported capability -> reject；
- stream 不属于 node -> reject；
- frozen stream -> reject；
- Hub ACK 与 Node local ack 不一致 -> 以 Hub committed contiguous ACK 恢复。

## 14. Sequence / ACK

| 输入 | 期望 |
| --- | --- |
| seq = ack+1 | 正常提交 |
| seq <= ack 且 hash 相同 | 返回已有 ACK |
| seq <= ack 且 hash 不同 | SEQUENCE_REUSE_CONFLICT |
| seq > ack+1 | SEQUENCE_GAP |
| Hub commit 成功但 ACK response 丢失 | Node 重试，Hub 幂等返回 ACK |
| Hub transaction rollback | ACK 不推进 |

## 15. Bootstrap

覆盖：

- 空 Node；
- 10 万+历史 Entity；
- Bootstrap 中继续产生新 Observation；
- Bootstrap 中网络断开；
- Daemon 重启；
- Hub 重启；
- resume from ACK；
- Bootstrap complete 后 mandatory reconciliation；
- 最终 Hub 与当前允许复制状态收敛；
- 不通过 scan missing 推断删除。

## 16. Reconciliation

关键故障窗口：

```text
Canonical commit success
 -> process crash
 -> fast path not enqueued
```

恢复后 Reconcile 必须补齐。

还需验证：

- acknowledged hash 相同不重复发送；
- Entity 更新后 hash 改变进入 pending；
- Promotion alias 参与 resolve；
- Tombstone 不能由 absence 自动制造；
- 周期校准对稳定数据无大量重复写。

## 17. Tombstone / Delete

Node-scoped：

- 删除按依赖逆序；
- dependent 未处理 -> whole batch reject；
- duplicate tombstone idempotent。

Shared：

- Node A withdrawal 不删 Node B assertion；
- promotion 后 old origin tombstone 只撤回该 assertion；
- no assertion + no refs 才可 GC；
- Revocation 不自动等于 withdrawal。

## 18. Pairing

覆盖：

- 有效 Offer 成功；
- Secret 过期；
- Secret 已消费；
- 错 Secret 多次触发限制；
- 未验证 self-signed Hub SPKI 时不发送 Secret；
- Pair 成功后长期请求不再使用 Secret；
- re-pair 产生新 stream；
- re-pair 不重复创建 ReplicaKey。

## 19. TLS / Signature

- 公共 CA 正常；
- self-managed TLS + correct SPKI；
- SPKI mismatch；
- certificate renewal same key；
- TLS config invalid 不降级 HTTP；
- body bit changed -> signature fail；
- method/path changed -> signature fail；
- nonce replay -> reject；
- timestamp 超窗 -> clear clock-skew diagnostics；
- revoked key -> reject。

## 20. Revocation / Identity Reset

- revoke -> future replication rejected；
- revoke -> Hub history remains；
- revoke -> no automatic shared history delete；
- reset identity -> new nodeId/key，local Canonical unchanged；
- reset 后必须 re-pair；
- reset 后同步到 Hub 使用新 Replica Namespace；
- two active clones -> freeze / conflict。

## 21. Hub Endpoint / Identity

- IP change + same Hub Identity -> can reconnect after endpoint update；
- same IP + changed Hub Identity -> blocked；
- TLS cert renew same SPKI -> no re-pair；
- Hub Identity key loss -> cannot silently impersonate old Hub。

## 22. Operational UX

手工 / UI 自动化至少验证：

- offline / degraded / blocked 区分；
- “Hub 同步延迟，本机采集正常”可见；
- policy 当前值可见；
- 是否补传历史明确；
- revoke 与 delete-history 两动作分离；
- delete-history 有 impact preview；
- Pure Hub 明确本机不采集；
- Hub 本机显示“本机”；
- 普通 UI 不暴露 ReplicaKey / streamId；
- 不出现远程 Shell / Agent control。

## 23. Cross-platform

Windows / macOS / Linux 至少覆盖：

- node identity 文件权限 / ACL；
- 路径差异不影响 Shared Project remote identity；
- Windows drive letter / slash normalization 只用于本机 Workspace，不变成 Shared Identity；
- service / desktop 生命周期与 replication plugin 共存；
- TLS key file handling；
- hostname 改变 nodeId 不变。

## 24. 性能基线

建议样本：

```text
Nodes: 1 / 2 / 5 / 10
Observations: 100k / 1m / 5m+
```

指标：

- Bootstrap entities/s、MB/s；
- steady-state p50/p95 replication delay；
- Hub batch transaction latency；
- reconciliation scan duration；
- pending backlog disk size；
- unified session list latency；
- usage aggregation latency；
- SQLite lock / busy rate；
- memory peak。

性能优化不能绕过 Canonical / Projection 架构护栏。

## 25. Soak / Dogfood

至少一次长时间真实环境：

```text
1 Hub
2+ Nodes
24h+
真实 Claude / Codex / Pi / Hermes / OpenCode 中已启用来源
网络断开 / 恢复
Node sleep / wake
Hub restart
Node restart
```

验收：

- 无重复 Session / Observation 爆炸；
- backlog 最终归零 / 收敛；
- Shared Project 不漂移；
- identity conflict 无误报；
- Hub Web 查询保持可用；
- Local Node 独立使用不受影响。

## 26. Release Gate

Hub Alpha 进入可狗粮状态前至少满足：

- L1-L5 自动测试主链通过；
- 三平台关键 identity / protocol 测试通过；
- Security cases 通过；
- Bootstrap / Reconcile failure injection 通过；
- 真实 2+ Node 狗粮通过；
- 文档与实现状态同步；
- 未实现的 delete / remote-web / federation 等能力在 UI 明确不可用，不伪造完成状态。
