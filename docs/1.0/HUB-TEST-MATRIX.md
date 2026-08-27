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

核心身份 / Shared Group / Protocol / History / Policy 语义必须在 L1-L4 可稳定验证。

## 2. Standalone 回归

| 场景 | 期望 |
| --- | --- |
| 无 Hub 配置启动 | 行为与当前 1.0 一致 |
| replication plugin inactive | Source / Canonical / Web 正常 |
| Hub 配置损坏但 replicationUpstream=false | 不影响本机启动 |
| Replication 网络错误 | 不影响 Observation Commit |
| Desktop / npm 共存 | 一个默认 Daemon / 数据根 / Node Identity |

## 3. Node Identity / Runtime Instance

- 首次初始化生成 nodeId；
- 重启 nodeId 不变；
- 每次 Daemon 启动 runtimeInstanceId 改变；
- hostname / AgentLens 升级不改变 nodeId；
- 显式 reset 生成新 nodeId；
- 两台同 hostname/platform/arch 机器 nodeId 不同；
- 克隆数据根同时运行时 Hub 不静默合并。

## 4. Capability Composition

| Profile | Source | Upstream | Hub Accept |
| --- | --- | --- | --- |
| Standalone | 开 | 关 | 关 |
| 普通接入节点 | 开 | 开 | 关 |
| Hub | 开 | 关 | 开 |
| Pure Hub | 关 | 关 | 开 |

必须拒绝：

- hubAccept=true && replicationUpstream=true；
- localCapture=false && replicationUpstream=true；
- 全 false。

## 5. Replica Key

- same Node + type + originId -> same ReplicaKey；
- different Node + same originId -> different ReplicaKey；
- different entity type -> different ReplicaKey；
- Node 提供的 replicaKey 与 Hub 重算不一致 -> reject；
- 不按字符串格式猜 Scope。

## 6. Entity Scope / Physical Model

### Shared Root / AgentProduct

- same productId -> one Shared Canonical Root；
- metadata deterministic merge；
- arrival-order independent。

### Project Conditional Shared

- D:\foo 与 /home/foo 不自动合并；
- HTTPS / SSH 同 Git remote -> same Shared Project Group；
- userinfo / credential / query / fragment 不参与 identity；
- different repo path -> different group；
- **每个 Node 保留自己的 Project Origin Row / ReplicaKey**；
- Workspace.projectId 始终指对应 origin Project Row，不指 SharedProjectKey；
- Hub Local + Remote 同 Portable Project -> 同 Group、多个 origin members。

### AssetDefinition Conditional Shared

- 同名 review 无 Portable Identity -> 不 Group；
- 同 Portable Identity -> same Shared Asset Group；
- 每个 origin AssetDefinition Row 保留；
- AssetBinding.assetDefinitionId 指 origin row，不指 SharedAssetKey；
- invariant 冲突 -> diagnostics / conflict。

### ToolDefinition

- 两 Node 都叫 Read 仍 Node-scoped；
- schemaHash 不同不提前合并。

## 7. Typed EntityRef

- node ref 正确解析 ReplicaKey；
- shared ref 正确解析 Shared Root；
- Project / AssetDefinition 有 Shared Membership 时，Domain Ref 仍必须是 node ref；
- Conditional Shared Entity 若以 scope=shared 发送 -> reject；
- node ref 指向另一个 Node -> Alpha reject；
- 缺必须依赖 -> Batch rollback；
- Coverage subjectRef 正确；
- payload 内 ID 字符串不改写。

## 8. Dependency DAG

- DTO 数组随机顺序结果相同；
- Shared Root -> Host -> Installation -> Conditional Origin -> Membership -> Workspace/Session -> Observation 依赖完整；
- Promotion 声明可先出现，但 Membership 只有 origin row 校验成功后才落库；
- Actor cycle / missing relationship / missing evidence -> whole batch rollback。

## 9. Shared Group / Assertion Merge

必须验证：

```text
commutative
associative（定义范围内）
idempotent
arrival-order independent
```

Project Group：

- repositoryIdentity invariant；
- createdAt=min；lastSeenAt=max；
- name 差异 diagnostics；
- assertion 原始时间保留。

Membership：

- A/B 同 Project -> 2 origin Project Rows + 1 Shared Group + 2 memberships；
- Hub Local 加入 -> 3 origin members，仍 1 Group；
- A metadata 更新 -> group recompute；
- A withdrawal -> B / Hub Local 仍存在；
- 全部 membership 撤回后 Group 才 eligible for GC；
- Group GC 不删除仍存在 origin rows。

## 10. Identity Promotion

- path-only Project 后同 Workspace 发现 Git Remote -> Membership Promotion；
- Promotion **不修改** Workspace.projectId / Session.projectId / Observation.projectId 等 origin FK；
- origin Project Row 不因 Promotion 被删除；
- 重复 Promotion 幂等；
- old origin provenance 保留；
- same origin -> Shared A 后再 Shared B -> conflict；
- Hub 不按 name/path 相似度自动 Promotion；
- 同一 Node old/new Project origin IDs 有强证据时可 Membership 到同 Group；
- Asset 无强证据不 Promotion。

禁止测试或实现把“批量 FK Rewrite 成 SharedKey”当成 Alpha 正确行为。

## 11. Replication Policy 字段矩阵

### metadata-only

- Prompt / Tool body 不出站；
- SourceRecord payload 不偷带正文；
- Workspace 完整路径默认 omitted；
- executable / configRoot / dataRoot 默认 omitted；
- Repository Identity 可按规范化身份发送；
- UI 不得声称匿名。

### redacted

- 出站再次脱敏；
- 三平台 home path 规则一致；
- credential 强制遮蔽；
- 长度限制有效。

### full

- 只复制本机已允许保存正文；
- Capture off 无法恢复；
- 凭据仍遮蔽。

Hub 可区分 original null / omitted / not captured / redacted。

## 12. Repository Identity 安全

- URL credential 不进入 SharedKey；
- credential 不进入 Wire / log / diagnostics；
- metadata-only 仍明确披露 repo identity 会同步。

## 13. History Scope

### include-existing

- 既有历史进入 Bootstrap；Policy 仍限制字段。

### from-now

- Boundary 前旧 Observation 不补传；
- Reconciliation 不绕过 Boundary；
- 新 Observation 可发送；
- 必须的旧 Host / Installation / Project / Session 依赖可补齐；
- 依赖闭包不带出旧 Session 全正文；
- 后发现的旧原生历史不能仅凭 capturedAt 新就越过 Boundary。

## 14. Policy / History Revision

- Policy / History revision 单调；
- Batch / Status 可追溯；
- Hub 不能通过 revision 改 Node 设置。

## 15. Policy 收紧 / 放宽

收紧：

- 新旧 Policy 请求立即分界；
- ambiguous old-policy Batch 不允许换内容复用 sequence；
- 不为填 gap 继续发送已禁止正文；
- Stream Rollover 后按新 Policy Reconcile；
- Hub 已有 full 数据不会被错误声称已清除。

放宽：

- 选择“仅从现在开始”不补旧正文；
- 用户明确补传历史才扩大 History Revision；
- backlog 不混淆不同授权 revision。

## 16. Protocol Handshake / Hub Proof

- R1 minor 协商；
- no common major -> PROTOCOL_UNSUPPORTED；
- capability / stream / hub ownership 错误 -> reject；
- Hub ACK 是恢复基准；
- Pairing Receipt / serverProof 可验证；
- same endpoint + changed Hub Identity -> blocked。

## 17. Request Signature

修改 body / method / path / Hub-Id / Node-Id / Stream-Id / Key-Id 任一项 -> signature fail。

Nonce replay、timestamp 超窗、revoked key 均拒绝。

## 18. Sequence / ACK / Commit Ambiguity

| 输入 | 期望 |
| --- | --- |
| seq=ack+1 | commit |
| seq<=ack + same hash | existing ACK |
| seq<=ack + different hash | SEQUENCE_REUSE_CONFLICT |
| seq>ack+1 | SEQUENCE_GAP |
| commit 后 ACK 丢失 | exact immutable retry |
| timeout 状态不确定 | 不允许同 seq 新 Body |
| committed=false BATCH_TOO_LARGE | 可重切 expected seq |
| rollback | ACK 不推进 |

## 19. Deterministic Hash

- 三平台同 Wire DTO hash 相同；
- JSON key 顺序不影响 hash；
- entityVersion / SharedIdentity / omitted/redacted 改变会改变 hash；
- 非 JSON 值 reject；
- Raw Body Hash 与 Entity JCS Hash 不混淆。

## 20. Bootstrap / Reconciliation

Bootstrap：空 Node、10 万+历史、中途继续采集、断网、Node/Hub restart、resume、complete 后 mandatory reconcile。

Reconciliation：

```text
Canonical commit success
 -> crash before fast path
 -> restart
 -> reconcile repairs pending state
```

还需验证 History Boundary、Membership、Tombstone、稳定数据无重复写。

## 21. Replica Generation / Re-bootstrap

- G1 active / G2 staged；
- G2 未完成仍读 G1；
- G2 失败不污染 G1；
- G2 complete + reconcile + validate 才 activate；
- old generation stale origin 可清理；
- **该 Remote Node 的 Conditional Shared Membership 也必须 staged 到 G2**；
- G2 未激活前正式 Shared Group 仍读 G1 memberships；
- G2 激活只切换该 Node memberships，不影响其他 Remote Node / Hub Local membership；
- 普通 Reconcile absence 仍不 delete。

## 22. Tombstone / Retention

- origin delete 依赖安全顺序；
- duplicate tombstone 幂等；
- Conditional origin delete 撤回自己的 membership；
- member withdrawal 不删其他 members；
- Revocation 不自动 withdrawal；
- Tombstone 未 ACK / consistency checkpoint 前不 GC；
- frozen stream receipt 不立即丢失；
- Shared Group Membership / Promotion provenance 按长期状态保留；
- 不要求 Conditional Shared 主键 Alias。

## 23. Pairing / TLS

- Pair Secret 过期 / 已消费；
- nodeProof；
- self-signed SPKI；
- public CA；
- cert renewal same key；
- TLS config invalid 不降级 HTTP；
- Re-pair new stream，不重复 origin ReplicaKey；
- Stream Rollover 不要求 Re-pair。

## 24. Clone Detection

- 真正并发 runtime + sequence divergence -> freeze；
- IP / hostname / sleep-wake 单独不 freeze；
- metadata 变化只 diagnostics；
- reset identity 后新 Node。

## 25. Operational UX

- offline / degraded / paused / blocked 区分；
- Local-first 状态明确；
- Policy / History Scope 可见；
- revoke / delete-history / rebootstrap / reset 分离；
- delete preview；
- Pure Hub 本机不采集；
- Hub Local 标“本机”；
- Project Group 展示多个 Workspace，但不把 Group Key 暴露给普通用户；
- 无 Remote Shell / Agent Control。

## 26. Cross-node Time

- serverTime 只做 skew；
- replicatedAt 不覆盖业务时间；
- 不声称跨 Node 毫秒全序；
- stable tie-break 保证分页确定。

## 27. Cross-platform / Distribution

- key 权限；
- path redaction；
- Git remote normalization；
- service / desktop 与 replication plugin 共存；
- npm / Desktop 切 owner 不改变 nodeId / relationship；
- 卸载一种发行不删共享 Hub state。

## 28. Resource Protection

- maxBatchBytes pre-parse；
- maxEntityBytes / maxEntitiesPerBatch；
- per-node rate / concurrency；
- Hub storage pressure；
- malicious body 不 OOM；
- compression 若未来支持限制解压后大小。

## 29. 性能基线

```text
Nodes: 1 / 2 / 5 / 10
Observations: 100k / 1m / 5m+
```

指标至少包括 Bootstrap throughput、replication delay、batch transaction、reconcile、backlog disk、generation staging amplification、Shared Group membership count / resolve latency、unified session / usage latency、SQLite busy、memory peak。

## 30. Soak / Dogfood

至少：1 Hub + 2 Nodes + 24h+，包含网络断开恢复、sleep/wake、Hub/Node restart。

验收：无重复事实爆炸、backlog 收敛、Shared Group 不漂移、clone conflict 无误报、Hub Web 可用、Local Node 独立使用正常。

## 31. Release Gate

- L1-L5 主链；
- 三平台 identity / protocol / policy；
- Security；
- History Boundary / Bootstrap / Reconcile failure injection；
- Stream Rollover / Generation；
- Conditional Shared Origin + Group Membership Contract；
- Resource pressure；
- 真实 2+ Node dogfood；
- 文档 / 实现状态同步；
- 未实现能力明确不可用。
