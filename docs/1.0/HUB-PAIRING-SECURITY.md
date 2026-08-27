# AgentLens 1.0 Hub Pairing 与安全边界

更新日期：2026-08-27  
状态：Alpha 安全设计，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-STATE-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `docs/1.0/HUB-DATA-EXPOSURE-MATRIX.md`
- `SECURITY.md`

本文定义 Hub Replication 的身份、配对、TLS、密钥、Hub 身份证明、撤销、重放保护、Clone Detection 与敏感数据边界。它不为现有本机 Web API 增加网络认证，也不把 Hub 变成远程管理平台。

## 1. 威胁模型

Alpha 至少防御：

- 未配对机器上传；
- 已撤销 Node 继续上传；
- 伪造发现 / endpoint 诱导 Node；
- 中间人替换自签 Hub；
- endpoint 相同但服务器已不是原 Hub；
- 请求重放；
- 合法 Body 被改挂其他 Node / Stream Header；
- 克隆数据根造成相同 Node Identity 并发；
- 请求篡改；
- Pairing Secret 被长期使用；
- 私钥 / Secret 泄入 Canonical、日志、备份；
- 已配对但被攻陷 Node 的资源滥用。

Alpha 不声称防御已经完全控制 Node / Hub OS 管理员权限的攻击者，也不把已配对 Node 的业务事实声明视为远程证明（Remote Attestation）。

## 2. 三类身份必须分离

### Node Identity

```text
nodeId = persistent random UUID
Node key pair = long-term request identity
```

nodeId 不等于 hostname / Host.id / Pairing。

### Hub Identity

```text
hubId
hub key pair
```

Hub Key 签名 Pairing Receipt / Handshake serverProof；不能只是装饰字段。

### TLS Identity

TLS Certificate 负责传输端点；Hub Identity 负责长期产品信任身份。证书续期不等于新 Hub。

## 3. 本地密钥存储

默认数据根中 Node / Hub / TLS private material 必须使用最小文件权限 / ACL；不得进入 Canonical 表、SourceRecord、Evidence、Observation、普通 Asset Backup 或 Replication Batch；日志只输出截断 keyId/fingerprint。npm/Desktop 共用一套默认身份材料。

未来可接 OS Credential Store，但 Alpha 不强依赖某个平台。

## 4. Pairing Secret

至少 128 bit CSPRNG，短有效期、单次成功即失效、失败次数受限；Hub 只存 verifier，不长期存明文。短显示码不能是全部安全熵。

## 5. 首次配对

Hub 生成 Pairing Offer：hubId、endpoint、Hub Identity fingerprint、TLS trust hint、Secret、expiresAt。

Node 在发送 Secret 前先验证公共 CA/hostname 或自管理 TLS SPKI Pin。Discovery 只提供 endpoint。

Pair Request 包含 nodeId、nodePublicKey/keyId、displayName、version/protocol、Secret、nodeProof。nodeProof 证明持有 Node Private Key。

Hub 验证后注册 Node、创建 stream、消费 Secret，并由 Hub Identity Private Key 签 Pairing Receipt，至少绑定 Hub/Node/Key/Stream/时间/Protocol Range。Node 必须验证并持久化 Receipt。

## 6. Pairing Receipt

Receipt 不能由 endpoint/IP/TLS Certificate 代替。IP/hostname/证书正常续期时，长期信任仍由 Hub Identity 验证。

## 7. Handshake Hub Proof

Node 发送 clientNonce；Hub serverProof 至少绑定 clientNonce、hubId、nodeId、streamId、selectedProtocol、hubAckSequence、serverTime。Node 只有 TLS/SPKI + Receipt + serverProof 全部有效才发送 Replication Data。

## 8. TLS

自管理 TLS：Pin SPKI，不 Pin 整张证书；同 Key 续签无需 Re-pair；TLS Key 变化不能静默接受。

公共 CA：正常 CA/hostname 验证。TLS 配置失败不得降级明文 HTTP。

## 9. 长期 Node 请求认证

R1 Signature 绑定：method、path、hubId、nodeId、streamId、keyId、timestamp、nonce、raw body SHA-256。Hub 用注册 Public Key 验证。

## 10. 重放保护

Timestamp 默认建议 ±5 分钟、Nonce window、contiguous Sequence、same-sequence same-hash。Clock Skew 使用明确诊断，不作为网络错误。

## 11. Clock Skew 与业务时间

签名 Timestamp / serverTime 只用于安全与 skew diagnostics。Hub 不用 receive time 覆盖 occurredAt / capturedAt，也不把跨 Node 时间戳当可信全局因果序。

## 12. Node Revocation

Revocation 冻结 stream、拒绝未来上传、默认保留已有历史。它不等于删除历史 / Shared Membership / 本机数据。

## 13. Node Key Rotation

有旧私钥时由旧 Key 签新 Key rotation；nodeId 可保留。旧 Key 丢失/泄露时需要 revoke + explicit re-pair + new stream；是否复用 nodeId 需用户明确授权。

## 14. Hub Identity Rotation

Alpha 不做无感 Rotation。Hub Identity Key 丢失/更换默认要求 Node 重新确认/Re-pair；endpoint 相同不能绕过。

## 15. Clone Detection

每次 Daemon 启动生成临时 runtimeInstanceId。

强信号：同 nodeId/stream 真正并发不同 runtimeInstance、sequence 分叉、同 stream 不同 immutable Batch 竞争。

弱信号：IP/hostname/metadata 变化、sleep/wake 旧连接残留。弱信号只 diagnostics，不能单独冻结。

强冲突才 `IDENTITY_NODE_CONFLICT -> freeze stream`。

## 16. Pairing 与 Policy / History Scope

首次 Pairing 必须明确 metadata-only/redacted/full 与 from-now/include-existing。连接 Hub 不等于默认上传整个本地数据库。

## 17. Local Web 与 Replication Surface

```text
Local Web/API -> 127.0.0.1:56789, no network auth
Replication Surface -> authenticated HTTPS
```

Replication Credential 不能用于网页登录。Headless Pure Hub 用本机/SSH CLI或用户自建可信 loopback tunnel 管理。

## 18. 网络发现

mDNS/LAN Discovery 全部不可信，只提供 endpoint hint。信任仍依赖 TLS/SPKI、Hub Identity、Pairing Secret、Receipt/Proof。

## 19. 日志与诊断脱敏

可记录截断 node/hub/stream ID、sequence、error code、protocol、bytes/count、skew。

禁止 Pair Secret、Private Key、完整 Signature、Prompt/Tool正文、Raw Batch、Authorization/Cookie/Token、带凭据原始 Repository URL。

## 20. Hub 聚合数据安全半径

Hub DB 汇聚多机数据，风险高于单 Node。数据根只允许当前 OS 用户；不宣称 SQLite 透明加密；full 用户优先系统磁盘加密；Canonical Replica 与 Security/Control Plane Recovery 分开设计。

## 21. Trusted Node 与数据真实性边界

Alpha 是：

```text
single user
+ explicitly paired trusted Nodes
```

密码学能证明：

```text
Node Key -> 这条请求由已配对 Node Key 发出
Request Signature -> 请求未被传输途中篡改
Shared Identity Recompute -> normalized identity / sharedKey 符合协商算法
```

密码学**不能证明**：

```text
这个 Node 真的拥有它声称的 Git repository
这个 Tool / Prompt / Session 一定来自真实上游 Agent
已被完全攻陷的 Node 没有伪造格式合法的 Canonical State
```

因此：

- Hub 将 originNodeId / assertion provenance 永久保留；
- Node A 不能修改 Node B 的 origin replica；
- Conditional Shared 只建立 Group Membership，不抹掉各 origin；
- Hub 重算 Shared Identity 是防止协议/key 算法不一致，不是 Repository Ownership Attestation；
- Shared Merge Conflict / impossible ownership change 必须拒绝或 diagnostics；
- 用户撤销被怀疑的 Node 后，历史是否删除由独立 Delete/Purge 操作决定。

如果未来要证明真实设备、TPM、Git provider ownership 或远程运行环境完整性，属于 Remote Attestation / Provider Verification 新安全能力，不在 Alpha Hub 范围。

## 22. 资源滥用保护

已配对 Node 也没有无限资源预算。限制 HTTP Body、单 Entity、Batch Entity Count、并发、Pairing 尝试、每 Node rate、Hub disk low-water mark。

资源压力使用 BATCH_TOO_LARGE / ENTITY_TOO_LARGE / SERVER_BUSY / SERVER_STORAGE_PRESSURE，不影响 Node Local Pipeline。

## 23. 安全验收不变量

- Secret 过期/消费后不可复用；
- nodeProof 无效不能注册 Key；
- Receipt / serverProof 不能被错误 Hub Key 伪造；
- 未配对/已撤销不能上传；
- SPKI mismatch 失败；
- Discovery 伪造不能建立信任；
- Replay / Header/Body 篡改失败；
- Clock Skew 有明确诊断；
- 非授权新 Node Key 不能替旧 Key；
- metadata/IP 变化不能单独 Clone Freeze；
- 真并发 clone 进入 conflict；
- Private Key / Secret 不进入普通数据链；
- Replication Credential 不能访问 Local Web；
- TLS 配置失败不降级；
- 超大恶意 Batch 不 OOM；
- Hub Identity 丢失不会被 endpoint 掩盖；
- Hub 重算 SharedKey mismatch 时拒绝 Membership；
- 一个已认证 Node 的 Shared Identity assertion 不被描述为 Git/Asset 所有权密码学证明；
- origin provenance 在 Shared Group 中仍可追溯。

## 24. 当前非目标

用户账号/Team/RBAC、OAuth/SSO、Remote Browser Login、多 Hub 信任网、无感 Hub Identity Rotation、HSM/TPM 强依赖、公有云控制面、数据库透明加密、Remote Attestation / Repository Ownership Proof。
