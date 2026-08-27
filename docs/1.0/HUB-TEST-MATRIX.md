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

L1 Unit / L2 Contract / L3 Storage Integration / L4 In-process E2E / L5 HTTPS Pairing E2E / L6 Cross-platform / L7 Failure Injection / L8 Performance / L9 Real-machine Dogfood。

核心身份 / Shared Group / Protocol / History / Policy 语义必须在 L1-L4 可稳定验证。

## 2. Standalone 回归

- 无 Hub 配置与当前 1.0 一致；
- replication plugin inactive 时 Source / Canonical / Web 正常；
- Hub 配置损坏但相关 capability=false 不影响启动；
- Replication 网络错误不影响 Observation Commit；
- Desktop / npm 共用一个 Daemon / 数据根 / Node Identity。

## 3. Node Identity / Runtime Instance

nodeId 首次生成后重启、hostname 变化、AgentLens 升级均不变；runtimeInstanceId 每次 Daemon 启动变化；显式 reset 产生新 nodeId；同 hostname 两台机器 nodeId 不同；克隆数据根并发时 Hub 不静默合并。

## 4. Capability Composition

合法：Standalone / Node / Hub / Pure Hub。拒绝 hubAccept+replicationUpstream、localCapture=false+replicationUpstream、全 false。

## 5. Replica Key Namespace

- same Node + type + originId -> same ReplicaKey；
- different Node / type -> different ReplicaKey；
- `agentlens-replica-r1` domain separator 参与算法；
- ReplicaKey 不使用本机 Project/Session/Host Identity 的生成域；
- 三平台相同输入得到相同 ReplicaKey；
- Node 自报 ReplicaKey 与 Hub 重算不一致 -> reject；
- 不通过字符串格式猜 Scope。

## 6. Entity Scope / Physical Model

### Shared Root / AgentProduct

same productId -> one Shared Canonical Root；metadata deterministic merge；arrival-order independent。

### Project Conditional Shared

- D:\foo 与 /home/foo 不自动合并；
- HTTPS / SSH 同 Git remote -> same Shared Project Group；
- credentials/query/fragment 不参与 identity；
- different repo path -> different group；
- 每个 Node 保留 Project Origin Row / ReplicaKey；
- Workspace.projectId 指 origin row，不指 SharedProjectKey；
- Hub Local + Remote 同 Portable Project -> 同 Group、多个 origin members。

### AssetDefinition Conditional Shared

- 同名无 Portable Identity 不 Group；
- 同 Portable Identity -> same Group；
- 每个 origin row 保留；
- AssetBinding 指 origin row；
- invariant conflict -> diagnostics/conflict。

ToolDefinition 同名仍 Node-scoped。

## 7. Shared Identity Algorithm

### project-repository-v1

- SSH / HTTPS 同 repo 归一一致；
- hostname case、`.git`、尾 `/` 按 Contract 处理；
- Provider path case 只有明确规则时才折叠；
- SharedProjectKey 使用 `agentlens-shared-project-v1` 独立 domain；
- Node assertion 的 normalizedIdentity / sharedKey 与 Hub 重算一致才接受；
- 篡改 sharedKey -> `SHARED_IDENTITY_MISMATCH`；
- 未协商 algorithm -> `IDENTITY_ALGORITHM_UNSUPPORTED`。

### asset-upstream-v1

- 只有 Portable Upstream Identity 才允许 Group；
- SharedAssetKey 使用独立 `agentlens-shared-asset-v1` domain；
- Hub 按类型专用 Resolver 重算；
- 本机 path / 临时 ID 不能伪装 Portable Identity。

### Version compatibility

- Hub Local / Remote 使用同一 Algorithm Version；
- v1 与未来不兼容 v2 不允许静默共用同一 SharedKey；
- normalization 语义改变必须有明确 version/migration gate。

## 8. Typed EntityRef

node ref 正确解析 ReplicaKey；shared ref 只解析 Shared Root；Conditional Shared 有 Membership 时仍 node ref；Project/AssetDefinition 以 scope=shared -> reject；非法跨 Node ref / 缺依赖 -> rollback；payload 内 ID 字符串不改写。

## 9. Dependency DAG

随机 DTO 顺序结果相同；Shared Root -> Host -> Installation -> Conditional Origin -> Membership -> Workspace/Session -> Observation 依赖完整；Promotion 只有 origin + algorithm + identity 校验成功后落 Membership；cycle/missing ref -> whole batch rollback。

## 10. Shared Group / Assertion Merge

验证 commutative / associative（定义范围）/ idempotent / arrival-order independent。

A/B 同 Project -> 2 Origin Rows + 1 Group + 2 memberships；Hub Local 可成为第三 member；withdraw A 不影响 B/Hub Local；全部 membership 撤回后 Group 才可 GC；Group GC 不删除仍存在 origin rows。

## 11. Identity Promotion

path-only Project 后发现 Git Remote -> Membership Promotion；不修改 Workspace/Session/Observation projectId；不删 origin row；重复幂等；同 origin A->B conflict；不按 name/path 猜；同 Node old/new origin IDs 有强证据时可加入同 Group；Asset 无强证据不 Promotion。

禁止把批量 FK Rewrite 成 SharedKey 当作 Alpha 正确行为。

## 12. Replication Policy / Exposure

metadata-only：不出 Prompt / Tool body / Raw SourceRecord payload / 完整 Workspace 路径 / executable configRoot dataRoot；Repository Identity 等结构元数据仍可发送，UI 不声称匿名。

redacted：三平台路径脱敏、credential 强制遮蔽、限长。

full：只复制本机已允许保存内容，Capture off 无法恢复，凭据仍遮蔽。

Hub 可区分 real null / omitted / not-captured / redacted。

## 13. Repository Identity 安全

URL credential 不进入 normalized identity / SharedKey / Wire log / diagnostics；metadata-only 明确披露 repo identity 可能同步。

## 14. History Scope

include-existing -> 既有历史 Bootstrap。

from-now -> Boundary 前旧 Observation 不补传；Reconcile 不绕过；新 Observation 可发送必要旧依赖；依赖闭包不带出旧 Session 全正文；配对后才发现的旧原生历史不能只因 capturedAt 较新越过 Boundary。

## 15. Policy / History Revision

revision 单调；Batch/Status 可追溯；Hub 不通过 revision 改 Node 设置。

## 16. Policy 收紧 / 放宽

收紧：ambiguous old-policy Batch 不换内容复用 sequence，不为了 gap 继续发已禁止正文，必要时 Stream Rollover，新 Policy Reconcile。

放宽：选择仅未来时不补历史；明确授权才扩大 History Revision。

## 17. Protocol Handshake / Hub Proof

R1 minor 协商；no common major -> blocked；unsupported shared identity algorithm -> reject；stream/hub ownership 校验；Hub ACK 恢复；Pairing Receipt / serverProof 可验证；same endpoint changed Hub Identity -> blocked。

## 18. Request Signature

修改 body/method/path/Hub-Id/Node-Id/Stream-Id/Key-Id 任一项 -> fail；Nonce replay / timestamp 超窗 / revoked key reject。

## 19. Sequence / ACK / Commit Ambiguity

- seq=ack+1 -> commit；
- <=ack same hash -> existing ACK；
- <=ack different hash -> conflict；
- >ack+1 -> gap；
- Commit 后 ACK 丢失 -> exact immutable retry；
- ambiguous timeout -> 不允许 same seq new body；
- committed=false oversized batch -> 可重切 expected seq；
- rollback -> ACK 不推进。

## 20. Deterministic Hash

三平台同 Wire DTO hash 一致；JSON key 顺序无关；entityVersion / SharedIdentity Algorithm/normalizedIdentity/sharedKey / omitted/redacted 改变会改变 hash；非 JSON 值 reject；Raw Body Hash 与 Entity JCS Hash 不混淆。

## 21. Bootstrap / Reconciliation

覆盖空 Node、10万+历史、Bootstrap 期间继续采集、断网/restart/resume/mandatory reconcile。Fast Path 丢失窗口由 Reconciliation 补齐。History Boundary / Membership / Tombstone 生效，稳定状态不产生大量重复写。

## 22. Replica Generation / Re-bootstrap

G1 active / G2 staged；G2 未完成仍读 G1；失败不污染；complete+reconcile+validate 才 activate；该 Remote Node Conditional Shared Membership 随 G2 staged；激活只切该 Node origin/membership set，不影响其他 Node/Hub Local；普通 reconcile absence 不 delete。

## 23. Tombstone / Retention

Origin delete 安全；duplicate idempotent；Conditional origin delete 撤自己的 membership；withdraw 不影响其他 members；Revocation 不自动 withdrawal；Tombstone 未 ACK/checkpoint 不 GC；frozen stream receipt 保留；Membership/Promotion provenance 长期保留；不依赖 Conditional Shared PK Alias。

## 24. Pairing / TLS / Clone

Pair Secret 生命周期、nodeProof、SPKI/public CA、cert renewal、invalid TLS no downgrade、Re-pair new stream/no duplicate Replica、Rollover no Re-pair。

Clone：真正并发 runtime + sequence divergence -> freeze；IP/hostname/sleep-wake 单独不 freeze；metadata 只 diagnostics；reset 后新 Node。

## 25. Operational UX

Local-first 状态、Policy/History Scope、危险操作分离、Delete Preview、Pure Hub、本机标识、Project Group 多 Workspace、无 Remote Control。

## 26. Cross-node Time

serverTime only skew；replicatedAt 不覆盖业务时间；不声称跨 Node 毫秒全序；stable tie-break 保证分页确定。

## 27. Cross-platform / Distribution

Key 权限、path redaction、Git remote normalization、service/desktop 共存、npm/Desktop 切 owner 不改变 nodeId/relationship、卸载一种发行不删共享 Hub state。

## 28. Resource Protection

maxBatchBytes pre-parse、maxEntityBytes/entities、per-node rate/concurrency、storage pressure、malicious body no OOM；若未来压缩限制 decompressed size。

## 29. Performance / Soak

2/5/10 Nodes，100k/1m/5m+ Observations。测 Bootstrap、delay、transaction、reconcile、backlog disk、generation staging、Shared Group membership resolve、unified query、SQLite busy、memory。

至少 1 Hub + 2 Nodes + 24h+ dogfood，覆盖网络恢复、sleep/wake、Hub/Node restart；无重复事实爆炸、backlog 收敛、Shared Group 不漂移、clone 无误报。

## 30. Release Gate

- L1-L5 主链；
- 三平台 ReplicaKey / Shared Identity Algorithm / Protocol / Policy；
- Security；
- History Boundary / Bootstrap / Reconcile failure injection；
- Stream Rollover / Generation；
- Conditional Shared Origin + Group Membership；
- Shared Identity mismatch / algorithm compatibility；
- Resource pressure；
- 真实 2+ Node dogfood；
- 文档 / 实现状态同步；
- 未实现能力明确不可用。
