# AgentLens 1.0 Hub Alpha 测试矩阵

更新日期：2026-08-27  
状态：测试设计，尚未实现  
目的：把 ADR 与 Hub Contract 中的架构不变量转成可执行验收清单，避免实现后只验证 happy path。

相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-PAIRING-SECURITY.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`
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

核心身份 / Merge / Protocol / History / Policy 语义必须在 L1-L4 可稳定验证，不允许所有问题都依赖真实多机手工复现。

## 2. Standalone 回归

| 场景 | 期望 |
| --- | --- |
| 没有任何 Hub 配置启动 | 行为与当前 1.0 一致 |
| 没有 replication plugin active | Source / Canonical / Web 正常 |
| Hub 配置损坏但 replicationUpstream=false | 不影响本机启动 |
| Replication 网络错误 | 不影响 Source / Observation Commit |
| Desktop / npm 共存 | 仍只有一个默认 Daemon / 数据根 / Node Identity |

这是所有 Hub 阶段持续必跑门禁。

## 3. Node Identity / Runtime Instance

- 首次初始化生成 nodeId；
- 重启 nodeId 不变；
- 每次 Daemon 启动 runtimeInstanceId 改变；
- 改 hostname 不改变 nodeId；
- AgentLens 升级不改变 nodeId；
- 显式 reset 生成新 nodeId；
- 两台同 hostname/platform/arch 机器 nodeId 不同；
- 复制数据根并同时运行时 Hub 不静默合并。

## 4. Capability Composition

合法组合：

| Profile | Source | Upstream Client | Hub Accept |
| --- | --- | --- | --- |
| Standalone | 开 | 关 | 关 |
| 普通接入节点 | 开 | 开 | 关 |
| Hub | 开 | 关 | 开 |
| Pure Hub | 关 | 关 | 开 |

必须拒绝：

- `hubAccept=true && replicationUpstream=true`；
- `localCapture=false && replicationUpstream=true`；
- 三项全 false 的无效空运行时配置。

Pure Hub 不执行 Detect / History / Runtime / Asset。

## 5. Replica Key

- 相同 Node + type + originId -> 永远同 ReplicaKey；
- 不同 Node + 同 originId -> 不同 ReplicaKey；
- EntityType 不同 + 同 originId -> 不同 ReplicaKey；
- Hub 重新计算与 Node 提供值不一致 -> reject；
- Node 本机 ID 格式变化不能让 Hub 通过字符串猜 Scope。

## 6. Entity Scope

### AgentProduct Shared

- 相同 productId 汇聚；
- 展示字段差异 deterministic merge；
- arrival order independent。

### Project Conditional Shared

- `D:\foo` 与 `/home/foo` 不合并；
- HTTPS / SSH 同 Git remote Normalize 后同 Shared Identity；
- userinfo / credential 不参与 identity；
- query / fragment 不参与 identity；
- 不同 repo path 不合并；
- Hub 本机与 Remote Node 同 Portable Project 可进入同一聚合组。

### AssetDefinition Conditional Shared

- 同名 `review` 无 portable identity 不合并；
- 同 portable identity 合并 / membership；
- 本机绝对路径不能作为 Shared Identity；
- invariant 冲突进入 diagnostics / conflict。

### ToolDefinition

- 两 Node 都有 `Read` 仍保持 Node-scoped；
- schemaHash 不同不提前合并。

## 7. Typed EntityRef

- node ref 正确解析；
- shared ref 正确解析；
- 缺 scope -> reject；
- node ref 指向另一个 Node -> Alpha reject；
- 缺必须依赖 -> Batch rollback；
- Coverage subjectRef 可引用 shared / node-scoped；
- payload 中出现 `session-xxx` 字符串不被改写。

## 8. Dependency DAG

- DTO 数组随机顺序结果相同；
- Host -> Installation -> Session -> Observation FK 完整；
- Actor parent DAG 正常；
- Actor parent cycle -> reject；
- SessionRelationship 缺一端 -> reject；
- Observation 缺 Evidence / Session -> reject；
- 任一阶段失败整个 Batch rollback。

## 9. Shared Merge / Assertion

Shared Merge 至少验证：

```text
commutative
associative（定义范围内）
idempotent
arrival-order independent
```

Project：

- createdAt -> min；
- lastSeenAt -> max；
- name 差异只 diagnostics；
- repositoryIdentity invariant；
- assertion 原始时间仍保留。

Assertion：

- A/B 同 Project -> 一个 Shared 聚合身份 + 两个 assertions；
- A metadata 更新 -> recompute；
- A withdrawal -> B 仍存在；
- Hub-local assertion 与 remote assertion 可共同参与聚合；
- 全部 withdrawal + 无引用后才 eligible for GC。

## 10. Identity Promotion

- path-only Project 后同 Workspace 发现 Git Remote -> promotion / shared membership；
- 重复 promotion 幂等；
- old origin 仍可追溯；
- 旧 Batch 重试不重新制造重复 identity；
- 同 origin promote 到 Shared A 后再到 B -> conflict；
- Hub 不根据 name/path 相似度自行 promotion；
- Shared Project remote 改变不按 promotion 处理；
- Asset 无强证据不 promotion。

如果实现采用 FK Rewrite，额外验证 IdentityService / Alias 可重入；下一次本机 Source 扫描不能重新制造旧 Project。

## 11. Replication Policy 字段矩阵

### metadata-only

- Prompt / Tool 正文不出站；
- SourceRecord payload 不偷带正文；
- Workspace 完整本机路径默认 omitted；
- executable / configRoot / dataRoot 默认 omitted；
- Repository Identity 仍可按规范化身份发送；
- UI 文案不得声称“匿名 / 无敏感元数据”。

### redacted

- 出站再次脱敏；
- Windows / macOS / Linux home path 脱敏一致；
- credential 强制遮蔽；
- 长度限制有效。

### full

- 只复制本机已允许保存正文；
- Capture off 无法恢复；
- 明确凭据仍遮蔽。

### 值状态

Hub 必须区分：

```text
original null
omitted by policy
not captured
redacted
```

## 12. Repository Identity 安全

- `https://user:token@example.com/org/repo.git` -> credential 不进入 Shared Key；
- credential 不进入 Wire；
- credential 不进入普通 log / diagnostics；
- metadata-only 仍明确披露 repo identity 会同步。

## 13. History Scope

### include-existing

- 既有历史进入 Bootstrap；
- Policy 仍限制字段。

### from-now

- 建立 Boundary 时已有旧 Observation 不补传；
- 后续 Reconciliation 不绕过 Boundary；
- 新 Observation 可发送；
- 新 Observation 需要的旧 Host / Installation / Project / Session 依赖允许补齐；
- 依赖补齐不带出旧 Session 的全部 Prompt / Tool 历史；
- Source 在配对后才发现的旧原生历史，不能仅因为 capturedAt 较新就自动视作“从现在开始”的新事实。

## 14. Policy / History Revision

- 每次 Policy 改动 revision 递增；
- 每次 History Boundary 扩大 revision 递增；
- Batch / status 可追溯 policyRevision / historyRevision；
- Hub 不通过 revision 修改 Node 设置。

## 15. Policy 收紧

- full -> metadata-only：新旧 Policy 请求立即分界；
- 未序列化 Candidate 按新策略处理；
- 明确未提交旧 Batch 可重建；
- ambiguous in-flight old-policy Batch 不允许换内容复用 sequence；
- 不允许为了补 gap 继续发送用户刚禁止的正文；
- Stream Rollover 后 existing Replica 不重复，Reconcile 按新 Policy 收敛；
- Hub 既有 full 数据不会被错误声称已自动清除。

## 16. Policy 放宽

- metadata-only -> full 但选择“仅从现在开始”时不补旧正文；
- 用户明确“补传已有历史”才扩大 History Revision；
- 补传通过 Bootstrap / Reconcile；
- backlog 中不同 revision 不被静默混为同一个授权状态。

## 17. Protocol Handshake / Hub Proof

- R1.0 Node + R1.2 Hub -> 共同最高 minor；
- R1 only + R2 only -> PROTOCOL_UNSUPPORTED；
- unsupported capability -> reject；
- stream 不属于 node / hub -> reject；
- frozen stream -> reject；
- Hub ACK 与 local ACK 不一致 -> 以 Hub committed ACK 恢复；
- Pairing Receipt 用 Hub Identity Public Key 可验证；
- Handshake serverProof 绑定 clientNonce / node / stream / protocol / ACK；
- serverProof 错误 -> Node 不发送 Batch；
- same endpoint + changed Hub Identity -> blocked。

## 18. Request Signature

- body bit changed -> fail；
- method/path changed -> fail；
- Hub-Id changed -> fail；
- Node-Id changed -> fail；
- Stream-Id changed -> fail；
- Key-Id changed -> fail；
- nonce replay -> reject；
- timestamp 超窗 -> AUTH_CLOCK_SKEW；
- revoked key -> reject。

## 19. Sequence / ACK / Commit Ambiguity

| 输入 | 期望 |
| --- | --- |
| seq = ack+1 | 正常提交 |
| seq <= ack 且 hash 相同 | 返回已有 ACK |
| seq <= ack 且 hash 不同 | SEQUENCE_REUSE_CONFLICT |
| seq > ack+1 | SEQUENCE_GAP |
| Hub commit 成功但 ACK response 丢失 | 重试完全相同 immutable Batch |
| timeout 后结果不确定 | 不允许同 seq 重组新 Body |
| 明确 committed=false 的 BATCH_TOO_LARGE | 可按 expected seq 重切批 |
| transaction rollback | ACK 不推进 |

## 20. Deterministic Hash

- Windows / Linux / macOS 对同 Wire DTO 的 canonical hash 相同；
- JSON key 顺序不同 hash 相同；
- entityVersion 改变 hash 改变；
- omitted / redacted 状态改变 hash 改变；
- NaN / Infinity / undefined 等非 JSON Wire 值被拒绝；
- Request Raw Body Hash 与 Entity JCS Hash 概念不混淆。

## 21. Bootstrap

- 空 Node；
- 10 万+历史 Entity；
- Bootstrap 中继续产生新 Observation；
- 网络断开；
- Node / Hub 重启；
- resume from ACK；
- Complete 后 mandatory Reconcile；
- 最终 Hub 与授权状态收敛；
- scan missing 不推断删除。

## 22. Reconciliation

关键故障窗口：

```text
Canonical commit success
 -> process crash
 -> fast path not enqueued
```

恢复后必须补齐。

还验证：

- acknowledged hash 相同不重复发送；
- Entity 更新后 hash 变化进入 pending；
- History Boundary 生效；
- Promotion / membership resolve 生效；
- Tombstone 不由 absence 自动制造；
- 稳定数据周期校准无大量重复写。

## 23. Replica Generation / Re-bootstrap

- G1 active 时构建 G2 staged；
- G2 未完成时用户查询仍读 G1；
- G2 bootstrap 失败不污染 G1；
- G2 Complete 后仍需 Reconcile；
- 只有 validate complete 后才 atomic activate；
- G2 激活后可 retire G1；
- old generation 有、new complete generation 无的 stale origin 可被安全清理；
- Shared Assertions 也按完整 Generation 重算；
- 普通 Reconcile absence 仍不产生 delete。

## 24. Tombstone / Retention

- Node-scoped delete 依赖安全顺序；
- duplicate tombstone 幂等；
- Shared withdrawal 不删其他 Node assertion；
- Revocation 不自动 withdrawal；
- Tombstone 未 ACK 不 GC；
- ACK 后未完成 consistency checkpoint 不 GC；
- Permanent Alias 不因旧 row 删除立即消失；
- frozen stream Sequence Receipt 不立即丢失。

## 25. Pairing

- 有效 Offer 成功；
- Secret 过期 / 已消费失败；
- 错 Secret 多次触发限制；
- self-signed Hub 未验证 SPKI 时不发送 Secret；
- nodeProof 无效不能注册 arbitrary public key；
- Pair 成功后长期请求不再使用 Secret；
- Re-pair 产生新 stream；
- Re-pair 不重复 ReplicaKey；
- Stream Rollover 不要求 Re-pair / 换 Node Key。

## 26. TLS / Endpoint

- 公共 CA 正常；
- self-managed TLS + correct SPKI；
- SPKI mismatch；
- certificate renewal same key；
- TLS config invalid 不降级 HTTP；
- IP change + same Hub Identity / SPKI 可按配置恢复；
- 公共 CA endpoint hostname 变化仍需满足 hostname validation；
- Hub Identity key loss 不能静默冒充旧 Hub。

## 27. Clone Detection

- 两个 runtimeInstanceId 真正同时竞争同 stream + sequence divergence -> freeze；
- 仅 IP 变化不 freeze；
- hostname 改变不 freeze；
- sleep / wake 产生短暂旧连接不误报；
- metadata 强烈变化只 diagnostics，不能单独作为 hard conflict；
- reset identity 后成为新 Node。

## 28. Operational UX

- offline / degraded / paused / blocked 区分；
- “Hub 同步延迟，本机采集正常”可见；
- Policy / History Scope 当前值可见；
- 是否补传历史明确；
- revoke / delete-history / rebootstrap / reset identity 分离；
- delete-history 有 preview；
- Pure Hub 明确本机不采集；
- Hub 本机显示“本机”；
- 普通 UI 不暴露 ReplicaKey / streamId；
- 不出现 Remote Shell / Agent Control。

## 29. Cross-node Time Semantics

- Handshake serverTime 可用于估算 Clock Skew；
- 超出签名窗口明确 blocked；
- 允许窗口内也不声称跨 Node 毫秒级全序；
- Hub 不用 replicatedAt 覆盖 occurredAt / capturedAt；
- 相同业务时间使用稳定 originNodeId + sequence / replicaKey tie-break；
- Pagination 在相同数据集上结果确定。

## 30. Cross-platform / Distribution

Windows / macOS / Linux 至少覆盖：

- node / hub key 权限；
- 路径脱敏；
- Git remote normalization；
- service / desktop 生命周期与 replication plugin 共存；
- npm / Desktop 切换 runtime owner 不改变 nodeId / upstream relationship；
- 卸载一种发行方式不删除共享 Hub Identity / Replication State；
- hostname 改变 nodeId 不变。

## 31. Resource Protection

- maxBatchBytes 在完整 parse 前生效；
- maxEntityBytes；
- maxEntitiesPerBatch；
- per-node rate limit；
- concurrency limit；
- Hub storage low-water；
- BATCH_TOO_LARGE 可切批；
- ENTITY_TOO_LARGE 不无限重试；
- SERVER_STORAGE_PRESSURE 只影响同步；
- 恶意请求不导致 Hub OOM；
- 若未来支持 compression，限制 decompressed size。

## 32. 性能基线

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
- staged Generation 临时磁盘放大；
- Sequence Receipt / Control Plane size；
- unified session list latency；
- usage aggregation latency；
- SQLite lock / busy rate；
- memory peak。

## 33. Soak / Dogfood

至少一次：

```text
1 Hub
2+ Nodes
24h+
真实已启用来源
网络断开 / 恢复
Node sleep / wake
Hub restart
Node restart
```

验收：

- 无重复 Session / Observation 爆炸；
- backlog 最终收敛；
- Shared Project 不漂移；
- clone conflict 无误报；
- Clock Skew diagnostics 不污染 Canonical；
- Hub Web 可查询；
- Local Node 独立使用不受影响。

## 34. Release Gate

Hub Alpha 进入可狗粮状态前至少满足：

- L1-L5 主链通过；
- 三平台关键 identity / protocol / policy 测试通过；
- Security cases 通过；
- History Boundary / Bootstrap / Reconcile failure injection 通过；
- Stream Rollover / Replica Generation 恢复测试通过；
- Resource pressure 测试通过；
- 真实 2+ Node 狗粮通过；
- 文档与实现状态同步；
- 未实现的 delete / remote-web / federation 等能力在 UI 明确不可用，不伪造完成状态。
