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

- 未配对机器向 Hub 上传伪造数据；
- 已撤销 Node 继续上传；
- 局域网伪造 mDNS / Hub 地址诱导 Node 发送敏感数据；
- 中间人替换自签 Hub；
- endpoint 相同但服务器已经不是原 Hub；
- 抓包后重放合法 Batch；
- 合法 Body 被改挂到另一个 Node / Stream Header；
- 一个复制出来的数据目录在两台机器同时使用同一 Node Identity；
- Node 请求被篡改；
- Pairing Secret 被长期当作密码使用；
- Hub / Node 私钥被意外写入 Canonical Observation、日志、备份或同步数据；
- 已配对但被攻陷的 Node 通过超大请求耗尽 Hub 资源。

Alpha 不声称防御已经完全控制 Node / Hub 操作系统管理员权限的攻击者。

## 2. 三类身份必须分离

### 2.1 Node Identity

表示一个 AgentLens 数据根 / 实例：

```text
nodeId = persistent random UUID
```

`nodeId` 不等于 hostname，不等于 Host.id，也不等于某次 Pairing。

Node 拥有长期非对称密钥：

```text
Node Identity
  nodeId
  keyId
  publicKey
  privateKey  # 只在 Node
```

Alpha 优先 Ed25519。

### 2.2 Hub Identity

Hub 拥有独立长期身份：

```text
Hub Identity
  hubId
  keyId
  publicKey
  privateKey  # 只在 Hub
```

`hubId` 是逻辑身份，不使用 IP / hostname 作为稳定身份。

Hub Identity Key 必须真正参与密码学证明：

- 签名 Pairing Receipt；
- 签名 Handshake `serverProof`；
- 未来如支持 TLS Key 平滑轮换，可用于签名新的 TLS Binding。

不能只把 Hub Public Key 存起来却从不验证它。

### 2.3 TLS Identity

TLS Certificate 负责传输加密与服务端连接认证；它与 Hub Identity 有关联，但不是同一个生命周期概念。

```text
Hub Identity = 产品 / 配对信任身份
TLS Identity = 传输层证书身份
```

证书续期不应被解释成“新的 Hub”；Hub Identity Key 变化则是高风险身份事件。

## 3. 本地密钥存储

概念目录：

```text
~/.agent-lens/1.0/
  node.json
  security/
    node-key.json / protected key material
    hub-identity.json        # Hub capability 启用时
    tls/                     # Hub 自管理 TLS 时
```

要求：

- POSIX 文件权限最小化；
- Windows 使用当前用户 ACL / 平台安全存储能力，禁止 Everyone 可读；
- 私钥不得进入 SQLite Canonical 表；
- 私钥不得进入 SourceRecord、Evidence、Observation、普通 Backup Snapshot、Replication Batch；
- 日志只允许输出 keyId / fingerprint 的短标识；
- 资产备份默认排除 Hub / Node Private Key 与 Pairing Secret；
- npm / Desktop 共用同一默认数据根时，不允许各自生成一套不同 Node / Hub Key。

未来可以接入 OS Credential Store，但 Alpha 架构不强依赖单一平台密钥库。

## 4. Pairing Secret

Pairing Secret 只用于首次授权某个 Node Public Key。

要求：

- 至少 128 bit CSPRNG 随机熵；
- 默认短有效期，建议 10 分钟；
- 单次成功使用后立即失效；
- Hub 限制失败尝试次数；
- 过期 / 使用后不能恢复；
- Hub 只存安全摘要 / verifier，不长期保存明文；
- 不能把只有 6 位数字的短码当作全部安全熵。

UI 可以显示分组编码 / QR，但底层 Secret 必须保持足够随机性。

## 5. 首次配对流程

### 5.1 Hub 创建 Pairing Offer

Hub 本机用户显式执行“添加设备”后生成：

```text
Pairing Offer
  hubId
  hubEndpoint
  hubIdentityFingerprint
  tlsFingerprint / trust hint（自管理 TLS 时）
  pairingSecret
  expiresAt
```

Offer 可以显示为文本 / QR。

### 5.2 Node 先验证 Hub Transport

Node 在发送 Pairing Secret 之前先确认连接目标：

- 公共 CA TLS：验证证书链与 hostname；
- 自管理 TLS：使用从 Hub 本机 Pairing Offer 得到的 TLS SPKI Fingerprint Pin；
- mDNS / LAN Discovery 只提供 endpoint，不提供信任。

不能使用“忽略证书错误”作为自托管方案。

### 5.3 Node Key Possession

Node 先生成：

```text
nodeId
Node key pair
```

Pairing Request 包含：

```text
nodeId
nodePublicKey
nodeKeyId
displayName
agentLensVersion
supportedProtocol
pairingSecret
nodeProof
```

`nodeProof` 必须由新 Node Private Key 对 Pairing Request 的关键身份字段签名，证明请求者确实持有该 Public Key 对应 Private Key。

Pairing Secret 解决“用户是否授权”；Node Proof 解决“请求者是否拥有这把 Node Key”。

### 5.4 Hub 返回 Pairing Receipt

Hub 验证 Secret 与 Node Proof 后：

- 注册 / 确认 Node；
- 保存 Node Public Key；
- 创建第一条 `replicationStreamId`；
- 返回 Hub Identity Public Key / Hub ID；
- 返回协议 / 限制信息；
- 立即消费 Pairing Secret；
- 使用 Hub Identity Private Key 签名 Pairing Receipt。

Pairing Receipt 至少绑定：

```text
hubId
hubKeyId
nodeId
nodeKeyId / nodePublicKey fingerprint
replicationStreamId
issuedAt
protocol major range
```

Node 必须验证并持久化 Receipt。

## 6. Pairing Receipt 的作用

Pairing Receipt 是 Node 与 Hub 长期信任关系的可验证证明。

它不能被 endpoint、IP 或 TLS Certificate 直接替代。

以后发生：

```text
IP change
hostname change
TLS certificate renewal
```

只要信任链仍满足规则，Node 仍可以证明自己连接的是拥有原 Hub Identity Private Key 的 Hub。

如果 Receipt 无法由已保存的 Hub Identity Public Key 验证，必须 blocked。

## 7. Handshake Hub Identity Proof

每次已配对 Handshake，Node 发送随机 `clientNonce`。

Hub Response 必须包含由 Hub Identity Private Key 签名的 `serverProof`，至少绑定：

```text
clientNonce
hubId
nodeId
replicationStreamId
selectedProtocol
hubAckSequence
serverTime
```

Node 只有同时满足：

```text
TLS / SPKI trust
+
Pairing Receipt trust
+
serverProof valid
```

才继续发送 Replication Data。

这样 Hub Identity 不会退化为一个装饰字段。

## 8. Hub 自管理 TLS

没有域名 / 公共 CA 时，Hub 可以自动生成 TLS Material。

Alpha：

- 默认生成长期 TLS Key + 自签证书；
- Node Pin TLS SPKI，而不是整张证书 hash；
- 同一 TLS Key 正常续签证书无需 Re-pair；
- TLS Private Key 轮换会改变 SPKI，不能静默接受；
- Alpha 对 SPKI 变化默认要求人工重新确认；
- 未来若做平滑轮换，可以由现有 Hub Identity Key 签名新的 TLS Binding。

### 8.1 Endpoint 变化

自管理 TLS 模式下，身份判断以：

```text
expected Hub Identity
+
pinned SPKI
```

为核心，IP 本身不是身份。

公共 CA 模式仍必须满足 CA / hostname 规则；改用另一个 hostname 时需要证书对新 hostname 有效。

## 9. 用户提供 TLS

Hub 可以使用用户提供的正式证书 / 私钥。

要求：

- 不改变 hubId；
- Node 仍保存 / 验证 Hub Identity；
- 公共 PKI 正常验证 CA / hostname；
- 配置错误时 Replication Surface 拒绝启动，不降级明文 HTTP；
- 本机 `surface-http` 继续 loopback。

## 10. 长期 Node 请求认证

Pairing 后，Node 使用私钥对 Replication 请求签名。

R1 Signature Input 由 Protocol 明确定义并绑定：

```text
method
path
hubId
nodeId
replicationStreamId
keyId
timestamp
nonce
raw body SHA-256
```

Hub 使用已注册 Node Public Key 验证。

Node / Stream / Hub Header 不能只在服务器做普通字段比较而不进入签名，否则存在 identity header substitution 风险。

## 11. 重放保护

Hub 至少验证：

- Timestamp 在允许时钟偏差范围；Alpha 建议默认 ±5 分钟；
- Nonce 在重放窗口内未使用；
- Batch Sequence 满足 contiguous cursor；
- 已提交同 sequence 重试 contentHash 必须一致。

Nonce Cache 属于 Control Plane。

时钟明显错误时使用明确：

```text
AUTH_CLOCK_SKEW
```

Node UI / CLI 应显示“系统时间偏差导致同步认证失败”，不是模糊“网络失败”。

## 12. Clock Skew 与业务时间分离

签名 Timestamp 只用于请求时效 / 重放保护。

它不能证明：

```text
Node A occurredAt 10:00:00
<
Node B occurredAt 10:00:01
```

具有可信的全局因果先后。

Handshake 提供 `serverTime` 用于估算 Clock Skew；该状态属于 Diagnostics，不进入 Canonical Observation。

Hub 不使用 receive time 覆盖 Node 的 `occurredAt / capturedAt`。

## 13. Node Revocation

Hub 必须支持显式撤销 Node：

```text
revoke node
 -> stop accepting future authenticated replication
 -> freeze active stream
 -> preserve already replicated history by default
```

撤销不等于：

- 删除 Hub 历史；
- 删除 Shared Identity；
- 删除 Node 本机数据；
- 清理 Agent 配置。

## 14. Node Key Rotation

`keyId` 与 `nodeId` 分离。

### 有旧私钥

可执行旧 Key 签名的新 Key Rotation：

```text
nodeId
oldKeyId
newKeyId
newPublicKey
rotationNonce
```

Node Identity 可以不变。

### 旧私钥丢失 / 泄露

不能只声称“我还是这个 nodeId”。

必须：

```text
revoke old relationship
 -> explicit re-pair
 -> new key
 -> new replicationStreamId
```

是否复用 nodeId 需要 Hub 本机用户明确授权。

## 15. Hub Identity Rotation

Hub Identity 比 TLS Certificate 更稳定。

Alpha 不做无感 Hub Identity Rotation。

Hub Identity Private Key 丢失 / 更换时：

- 视为高风险管理操作；
- 默认要求 Node 重新确认 / Re-pair；
- endpoint 相同不能绕过；
- 不把新 Hub 模糊匹配成旧 Hub。

以后如做平滑 Rotation，必须单独定义“旧 Hub Identity 签名新 Identity”的双阶段迁移。

## 16. Node Identity Clone Detection

复制整个数据根可能复制 `nodeId` 与 Private Key。

每次 Daemon 启动生成临时：

```text
runtimeInstanceId
```

Handshake 上报它，用于连接层冲突判断。

强冲突信号：

- 同一 nodeId / stream 出现同时活跃且无法解释的两个 runtimeInstanceId；
- sequence 出现不可解释分叉 / reuse conflict；
- 两个并发连接竞争同一个 Stream 并产生不同 immutable Batch。

弱信号：

- IP 变化；
- hostname / metadata 变化；
- sleep / wake 后短暂旧连接残留。

弱信号只能触发 Diagnostics，不能单独冻结 Node，避免笔记本换网 / 睡眠造成误报。

只有达到强冲突条件时：

```text
IDENTITY_NODE_CONFLICT
 -> freeze stream
 -> require explicit operator action
```

## 17. Pairing 与 Replication Policy / History Scope

首次 Pairing 必须明确：

```text
Replication Policy
  metadata-only | redacted | full

History Scope
  from-now | include-existing
```

连接 Hub 不能解释成默认上传全部数据库。

Policy / History Boundary 的变更和 Stream Rollover 规则见 State Contract。

## 18. Hub Web 与 Replication Surface 分离

Alpha：

```text
Local Web/API
 -> 127.0.0.1:56789
 -> no network auth

Replication Surface
 -> HTTPS
 -> authenticated Node protocol
```

Replication Credential 不能用于登录 Web。

Pure Hub 在 Headless Server 上可以通过本机 CLI / SSH CLI 或用户自己建立可信 loopback tunnel 管理；AgentLens 不因此开放无认证 Remote Web。

## 19. 网络发现

mDNS / LAN Discovery 未来可以发布：

```text
service name
hubId hint
endpoint
protocol hint
```

Discovery 全部视为不可信提示。

真正信任依赖：

```text
TLS / SPKI
Hub Identity
Pairing Secret
Pairing Receipt
```

Alpha 可以完全不实现 mDNS。

## 20. 日志与诊断脱敏

允许运维日志记录：

```text
nodeId / hubId / streamId 的截断值
batchSequence
error code
protocol version
bytes / entity counts
clock skew estimate
```

默认禁止：

```text
Pairing Secret
Private Key
完整 Request Signature
Prompt / Tool 正文
Raw Replication Body
Authorization / Cookie / Token
完整带 credential 的 Repository URL
```

诊断导出必须默认脱敏。

## 21. Hub 聚合数据的安全半径

Hub DB 可能包含多台机器的数据，风险高于单个 Node。

Alpha：

- Hub 数据根仅当前 OS 用户可访问；
- 不宣称 SQLite 自带透明加密；
- `full` 用户应优先使用受保护账户 / 系统磁盘加密；
- 普通 Asset Backup 不包含 Private Key；
- Canonical Replica 与 Security / Control Plane Recovery 是不同备份问题；
- Hub Identity Key 丢失时不能仅靠恢复 SQLite DB 假装信任关系仍有效。

字段级数据暴露见 `HUB-DATA-EXPOSURE-MATRIX.md`。

## 22. 资源滥用保护

已配对 Node 也不能获得无限资源预算。

Replication Surface 至少限制：

- HTTP Body bytes；
- 单 Entity bytes；
- Entity count / Batch；
- 并发请求；
- Pairing 尝试频率；
- 每 Node 请求速率；
- Hub 磁盘低水位。

资源压力返回稳定协议状态，例如：

```text
BATCH_TOO_LARGE
ENTITY_TOO_LARGE
SERVER_BUSY
SERVER_STORAGE_PRESSURE
```

Hub 资源问题不得阻断 Node 本机 Canonical Pipeline。

## 23. 安全验收不变量

至少验证：

- Pairing Secret 过期 / 使用后不能再次配对；
- Pairing Request 的 nodeProof 无效时不能注册任意 Public Key；
- Pairing Receipt 不能被错误 Hub Identity Key 伪造；
- Handshake serverProof 错误时 Node 不发送数据；
- 未配对 Node 无法 Handshake / Batch；
- 已撤销 Node 无法继续上传；
- 自管理 TLS SPKI 不匹配必须失败；
- mDNS 伪造不能建立信任；
- 重放合法请求会被 Nonce / Sequence 拒绝；
- 修改 Raw Body 或 Node / Stream / Hub Header 后签名失败；
- Clock Skew 超窗有明确诊断；
- 同 nodeId + 非授权新 key 不能自动替换旧 key；
- metadata / IP 变化不能单独触发 Clone Freeze；
- 两个实例真实竞争同一 Node / Stream 时进入 Identity Conflict；
- Private Key / Pairing Secret 不进入 Canonical DB、Replication Batch、普通日志或资产备份；
- Replication Credential 不能访问本机无认证 Web Surface；
- TLS 配置失败不降级成明文接口；
- 超大 / 恶意 Batch 不导致 Hub OOM；
- Hub Identity 丢失不会因为 endpoint 相同被误认成旧 Hub。

## 24. 当前非目标

Alpha 不实现：

- 用户账号体系；
- Team / Organization / RBAC；
- OAuth / SSO；
- 浏览器 Remote Login；
- 多 Hub 信任网；
- 自动 Hub Identity 无感轮换；
- HSM / TPM 强依赖；
- 公有云控制平面；
- 内建数据库透明加密。
