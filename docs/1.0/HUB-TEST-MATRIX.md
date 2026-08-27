# AgentLens 1.0 Hub Alpha 测试矩阵

更新日期：2026-08-27  
状态：设计冻结，尚未实现  
目的：把 ADR / Contract 转成实现门禁，避免只验证 happy path。

相关入口：`docs/1.0/HUB-DESIGN-INDEX.md`

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

Identity、Policy、History、Replica Storage、Shared Group、Protocol 的核心语义必须在 L1-L4 自动验证。

## 2. Standalone 回归

- 无 Hub 配置行为与当前 1.0 一致；
- replication plugin inactive 时 Source / Canonical / Web 正常；
- Hub 配置损坏但 capability 未启用不影响启动；
- Replication 网络错误不影响 Observation Commit；
- npm / Desktop 仍只使用一个默认 Daemon / 数据根 / Node Identity。

## 3. Node Identity / Capability

- 首次初始化生成 nodeId；
- 重启 nodeId 不变，runtimeInstanceId 改变；
- hostname / AgentLens 升级不改变 nodeId；
- reset identity 生成新 nodeId；
- 两台同 hostname/platform/arch Node nodeId 不同；
- 克隆数据根并发使用时不静默合并；
- 只允许 Standalone / Node / Hub / Pure Hub 四个 Profile；
- `hubAccept && replicationUpstream`、纯转发、全 false 被拒绝；
- Pure Hub 不运行 Source。

## 4. ReplicaKey / Public ID Namespace

- same nodeId + entityType + originId -> same ReplicaKey；
- different nodeId + same originId -> different ReplicaKey；
- different entityType + same originId -> different ReplicaKey；
- ReplicaKey 使用 `agentlens-replica-r1` domain separator；
- 编码后的 Remote ID namespace 与现有 `host-* / project-* / session-* / observation-*` Local ID 域可区分；
- Hub 重算 ReplicaKey 与 Node claimed value 不一致 -> reject；
- Hub 本机 Session ID 与 Remote Session ReplicaKey 可同时通过 `/review/:logicalSessionId` 正确定位；
- Web 把 ID 当 opaque string，不通过前缀做业务判断。

## 5. Entity Scope / Conditional Shared Physical Model

### Shared Root / AgentProduct

- same productId -> 一个逻辑 Shared Root；
- metadata deterministic merge；
- arrival-order independent；
- Remote assertion 不静默覆盖 Local Canonical metadata。

### Project

- `D:\foo` 与 `/home/foo` 不自动合并；
- HTTPS / SSH 同 Git Remote -> same Shared Project Group；
- userinfo / credential / query / fragment 不参与 identity；
- different repository path -> different group；
- 每个 Node 保留自己的 Project Origin Row / Remote Replica；
- Workspace.projectId 始终指 origin，不指 SharedProjectKey；
- Hub Local + Remote 同 Portable Project -> same Group / multiple members。

### AssetDefinition

- 同名 asset 无 Portable Identity 不合并；
- same Portable Identity -> Shared Asset Group；
- AssetBinding.assetDefinitionId 指 origin；
- invariant conflict -> Replication Conflict。

### ToolDefinition

- 两 Node 同名 Read 仍 Node-scoped；
- schemaHash 不同不提前合并。

## 6. Shared Identity Algorithm

- `project-repository-v1` 的 HTTPS / SSH Normalize 结果一致；
- `asset-upstream-v1` 只接受合法 Portable Identity；
- Identity Algorithm Version 进入 hash / negotiation；
- Node claimedSharedKey 与 Hub 重算一致 -> accept；
- 不一致 -> `SHARED_IDENTITY_MISMATCH`；
- unsupported algorithm -> `IDENTITY_ALGORITHM_UNSUPPORTED`；
- credential 不进入 normalizedIdentity / SharedKey / log；
- 若 Portable Identity 不允许出站，则该 origin 不建立 Shared Membership。

## 7. Typed EntityRef / Dependency DAG

- node ref -> origin ReplicaKey；
- shared ref -> Shared Root；
- Project / AssetDefinition 有 Membership 时 Domain Ref 仍为 node ref；
- Conditional Shared 以 `scope=shared` 作为 Domain FK target -> reject；
- cross-node direct ref -> Alpha reject；
- 缺必须依赖 -> whole Batch rollback；
- Actor cycle / missing Relationship / missing Evidence -> rollback；
- payload 中恰好出现 ID 字符串不被改写；
- DTO 数组随机顺序不改变 Import 结果。

## 8. Identity Promotion / Membership

- path-only Project 后发现稳定 Git Remote -> Membership Promotion；
- Promotion 不修改 Workspace / Session / Observation origin FK；
- origin row 不因 Promotion 删除；
- duplicate Promotion 幂等；
- same origin -> Shared A 后再 Shared B -> conflict；
- Hub 不根据 name/path 相似度自行 Promotion；
- 同 Node old/new Project origin IDs 有强证据时可进入同 Group；
- Member withdrawal 不影响其他 Node / Hub Local member；
- Group GC 不删除仍存在 origin rows。

## 9. Remote Replica Storage：Local / Remote 分层

必须证明一个 Hub SQLite / Storage Boundary 中：

```text
Local Canonical
Remote Replica
Shared Identity State
Replication Control Plane
```

可以共存，但 Remote Replica 不被强塞 Local Canonical Row。

场景：

- metadata-only Workspace.path omitted，不需要写 `'' / [hidden]`；
- omitted SourceRecord.payload 不写 `{}` 冒充原 Payload；
- Local Canonical Schema 不因 Hub 全局改 nullable；
- full / redacted / metadata-only 全走同一 Remote Replica Storage Contract；
- Policy 切换不把同 origin Entity 迁到另一套表造成重复；
- Local Project ID 与 Remote Project ReplicaKey 同库不碰撞；
- Batch transaction failure 不推进 ACK。

## 10. ReplicatedValue / Availability

Hub 必须区分：

```text
value
real null
redacted
omitted(policy)
omitted(not-captured)
omitted(history-boundary)
omitted(dependency-minimized)
retained prior value
```

验证：

- null 不等于 omitted；
- omitted 不显示成空字符串；
- redacted 不显示成原文不存在；
- Projection 不把 omitted Tool Result 算成“结果为空”；
- policy 收紧后的 retained prior value 不被标成当前 Revision 刚确认；
- Policy 放宽能在同 ReplicaKey 补齐先前 omitted 字段。

## 11. Replication Policy

### metadata-only

- Prompt / Tool body 不出站；
- SourceRecord payload 不出站；
- Workspace 完整路径默认 omitted；
- executable/configRoot/dataRoot 默认 omitted；
- cleaned Repository Identity 可以发送；
- UI 不声称匿名。

### redacted

- Windows / macOS / Linux 路径脱敏一致；
- credential 强制遮蔽；
- 长度限制有效。

### full

- 只发送 Local Capture 已允许内容；
- Capture off 无法恢复；
- 明确凭据仍遮蔽。

## 12. History Scope / Dependency-Minimized Closure

### include-existing

- 既有授权历史进入 Bootstrap；
- Policy 仍限制字段。

### from-now

- Boundary 前旧 Observation 不普通补传；
- Reconcile 不绕过 Boundary；
- Boundary 后新 Observation 正常发送；
- 必需旧 Host / Installation / Project / Workspace / Session 可作为 dependency；
- dependency 不携带旧 Session title、非必要 time、旧 Workspace full path、Prompt/Tool body、SourceRecord payload；
- 这些字段正确标记 history-boundary / dependency-minimized；
- Source 配对后才发现的旧原生历史不能仅凭 capturedAt 新而越界。

## 13. Policy / History Revision

- Policy Revision 单调；
- History Revision 单调；
- Batch / Status 可追溯；
- Hub 不通过 Revision 修改 Node 设置；
- Policy 放宽但选择 from-now 不补旧正文；
- 用户明确 include-existing 才扩大历史授权。

## 14. Policy 收紧 / retained prior

`full -> metadata-only`：

- 新请求立即遵守 metadata-only；
- 未序列化 pending state 按新 Policy；
- ambiguous old-policy Batch 不换 Body 复用 sequence；
- 不为补 gap 继续发送已禁止正文；
- Stream Rollover 后按新 Policy Reconcile；
- Hub 已有 full 内容不会被错误声称已自动清除；
- retained prior full value 与当前 omitted(policy) 同时可解释。

## 15. Handshake / Hub Proof / Identity Algorithm Negotiation

- R1 minor 协商；
- no common major -> PROTOCOL_UNSUPPORTED；
- no required identity algorithm -> blocked；
- Pairing Receipt 可验证；
- serverProof 绑定 clientNonce / Hub / Node / Stream / protocol / ACK；
- same endpoint + changed Hub Identity -> blocked；
- Hub ACK 是恢复基准。

## 16. Request Signature / Replay

修改 body / method / path / Hub-Id / Node-Id / Stream-Id / Key-Id 任一项 -> signature fail。

Nonce replay、timestamp 超窗、revoked key 均拒绝。

## 17. Sequence / ACK / Commit Ambiguity

| 输入 | 期望 |
| --- | --- |
| seq=ack+1 | commit |
| seq<=ack + same hash | existing ACK |
| seq<=ack + different hash | SEQUENCE_REUSE_CONFLICT |
| seq>ack+1 | SEQUENCE_GAP |
| commit 后 ACK response 丢失 | exact immutable retry |
| timeout 不确定 | 不允许 same seq 新 Body |
| committed=false BATCH_TOO_LARGE | 可重切 expected seq |
| transaction rollback | ACK 不推进 |

## 18. Deterministic Hash

- 三平台同 DTO hash 一致；
- JSON key 顺序不影响 hash；
- entityVersion / Typed Ref / SharedIdentity / availability 改变会改变 hash；
- 非 JSON Wire 值 reject；
- Raw Body Hash 与 Entity JCS Hash 不混淆。

## 19. Bootstrap / Reconciliation

Bootstrap：空 Node、10万+历史、期间继续采集、断网、Node/Hub restart、resume、Complete 后 mandatory Reconcile。

Reconcile 故障窗口：

```text
Canonical COMMIT success
 -> crash before fast path
 -> restart
 -> reconciliation repairs pending state
```

稳定数据周期校准不产生大量重复写。

## 20. Replica Generation / Re-bootstrap

- G1 active / G2 staged；
- G2 未完成正式 Query 仍读 G1；
- G2 failure 不污染 G1；
- complete + reconcile + validate 才 activate；
- Remote Conditional Shared Membership 也 staged 到 G2；
- G2 activate 只切换该 Node memberships；
- Hub Local / 其他 Node membership 不受影响；
- 普通 Reconcile absence 仍不 delete。

## 21. Unified Read Repository / Projection

验证：

- Local Canonical + active Remote Replica 能形成统一 Session List；
- staged / retired Generation 不进入正式 Query；
- Remote session 使用 ReplicaKey，Hub Local session 保持 Local ID；
- Review route 能正确区分两者；
- Node / Host / Shared Project filter 正确；
- Project Group 展示多个 Workspace；
- availability-aware Projection 不要求把 Remote Replica 强转成完整 Core Entity；
- Web 不直查 Replica 私表；
- `replicatedAt` 不覆盖 occurredAt/capturedAt。

## 22. Tombstone / Delete / Retention

- duplicate Tombstone 幂等；
- Origin delete 依赖安全；
- Conditional Origin delete 撤回自己的 Membership；
- Member withdrawal 不删其他 Member；
- Revocation 不等于 Delete；
- Tombstone 未 ACK / consistency checkpoint 前不 GC；
- Generation retire 后 stale Replica 安全清理；
- Policy Purge 与 Revocation / Policy Setting Change 分离。

## 23. Pairing / TLS / Clone Detection

- Pair Secret 过期 / 已消费；
- nodeProof；
- self-managed TLS + SPKI；
- public CA；
- cert renewal same key；
- TLS config invalid 不降级 HTTP；
- Re-pair new stream、不重复 origin ReplicaKey；
- Stream Rollover 不要求 Re-pair；
- IP / hostname / sleep-wake 单独不 freeze；
- 真正并发 runtime + sequence divergence -> hard conflict。

## 24. Trusted-node Security Boundary

验证安全声明没有越界：

- Node Signature 证明请求来自已配对 Node；
- SharedKey 重算证明算法一致；
- 系统不声称能证明 Node 现实中拥有 Repository / Asset；
- 已攻陷 Node 可以提交格式合法但虚假 origin fact，这属于 trusted-node 模型限制；
- Node A 不能修改 Node B origin；
- Resource Limits 限制失陷 Node 的影响面。

## 25. Cross-node Time

- serverTime 只做 skew / security；
- replicatedAt 不覆盖业务时间；
- 不声称跨 Node 毫秒全序；
- stable tie-break 保证相同数据集分页确定。

## 26. Cross-platform / Distribution

Windows / macOS / Linux 覆盖：key 权限、path redaction、Git remote normalization、identity hash、service / desktop coexistence、npm/Desktop 切 owner 不改变 nodeId / relationship。

## 27. Resource Protection

- maxBatchBytes pre-parse；
- maxEntityBytes / maxEntitiesPerBatch；
- per-node rate / concurrency；
- Hub storage low-water；
- malicious body 不 OOM；
- ENTITY_TOO_LARGE 不无限重试；
- SERVER_STORAGE_PRESSURE 只影响同步。

## 28. 性能基线

```text
Nodes: 1 / 2 / 5 / 10
Observations: 100k / 1m / 5m+
```

至少测：Bootstrap throughput、steady-state p50/p95 delay、Remote Import transaction、Reconcile、backlog disk、Generation staging amplification、Unified Session latency、Shared Group resolve、Usage aggregation、SQLite busy、memory peak。

## 29. Soak / Dogfood

至少一次：

```text
1 Hub
2+ Nodes
24h+
真实来源
network disconnect/recover
sleep/wake
Hub restart
Node restart
```

验收：无重复爆炸、backlog 收敛、Shared Group 不漂移、availability 不被假值污染、clone conflict 无误报、Hub Web 可查、Local Node 独立使用正常。

## 30. 五个极端场景纸面与自动化门禁

### A. metadata-only + from-now

新 Observation 引用旧 Session 时，只补最小 dependency；不泄露旧 path/title/body；Hub 无需伪造必填 Local Row。

### B. Hub Local + Remote 同 Project

Local Project Row、Remote Project Replica 各自保留；同 Portable Identity -> same Shared Group；所有 Workspace FK 仍指 origin。

### C. Re-bootstrap

G2 staged 不影响 G1 Query；G2 memberships 也 staged；完整校准后原子切换。

### D. full -> metadata-only

新正文停止出站；ambiguous old Batch 安全 Rollover；Hub old full value retained 但不冒充当前 Policy fresh value。

### E. Node Identity Reset

新 nodeId -> 新 Replica Namespace；旧 Hub history 默认保留；同一 Local DB 再 include-existing 可能出现 old/new Node 两套 origin history，产品必须提示，不能自动跨 nodeId 去重；Portable Project 仍可聚合到同 Shared Group。

## 31. Alpha Release Gate

进入 Hub Alpha Dogfood 前至少满足：

- L1-L5 主链；
- Standalone regression；
- Replica Storage availability；
- Remote ID namespace；
- Shared Identity Algorithm / Hub recompute；
- Policy / History / Dependency-Minimized tests；
- Security；
- Stream Rollover / Generation；
- Unified Read / Projection；
- Resource Pressure；
- 三平台关键 Contract；
- 真实 2+ Node Dogfood；
- 文档 / 实现状态同步；
- 未实现能力 UI 明确不可用。
