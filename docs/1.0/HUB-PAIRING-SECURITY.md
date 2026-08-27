# AgentLens 1.0 Hub Pairing 与安全边界

更新日期：2026-08-27  
状态：Alpha 安全设计，尚未实现  
相关文档：
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`
- `docs/1.0/HUB-REPLICATION-CONTRACT.md`
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`
- `SECURITY.md`

本文定义 Hub Replication 的身份、配对、TLS、密钥、撤销、重放保护和敏感数据边界。它不为现有本机 Web API 增加网络认证，也不把 Hub 变成远程管理平台。

## 1. 威胁模型

Alpha 至少防御：

- 未配对机器向 Hub 上传伪造数据；
- 已撤销 Node 继续上传；
- 局域网伪造 mDNS / Hub 地址诱导 Node 发送敏感数据；
- 中间人替换自签 Hub；
- 抓包后重放合法 Batch；
- 一个复制出来的数据目录在两台机器同时使用同一 Node Identity；
- Node 请求被篡改；
- Pair Code 被长期当作密码使用；
- Hub / Node 私钥被意外写入 Canonical Observation、日志、备份或同步数据。

Alpha 不声称防御已经完全控制 Node / Hub 操作系统管理员权限的攻击者。

## 2. 三类身份必须分离

### 2.1 Node Identity

表示一个 AgentLens 数据根 / 实例：

```text
nodeId = persistent random UUID
```

`nodeId` 不等于 hostname，不等于 Host.id，也不等于某次 Pairing。

Node 同时拥有长期非对称密钥：

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

`hubId` 是 Hub 逻辑身份，不使用 IP / hostname 作为稳定身份。

### 2.3 TLS Identity

TLS Certificate 负责传输加密与服务端连接认证；它与 Hub Identity 有关联，但不是同一个生命周期概念。

原因：

- TLS 证书可能正常续期；
- 用户可能从自签证书切换到公共 CA；
- 证书有效期通常短于 Hub 数据生命周期；
- “证书续期”不能被解释成“这是一个新的 Hub”。

因此：

```text
Hub Identity = 产品 / 配对信任身份
TLS Identity = 传输层证书身份
```

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

- POSIX 文件权限最小化，私钥仅当前用户可读；
- Windows 使用当前用户 ACL / 平台安全存储能力，禁止 Everyone 可读；
- 私钥不得进入 SQLite Canonical 表；
- 私钥不得进入 SourceRecord、Evidence、Observation、Backup Snapshot、Replication Batch；
- 日志只允许输出 keyId / fingerprint 的短标识，不输出私钥、Pair Secret 或完整 Authorization 材料；
- 资产备份默认排除 Hub / Node Private Key 与 Pairing Secret。

未来可以接入 OS Credential Store，但 Alpha 架构不依赖某个单一平台密钥库。

## 4. Pairing Secret

Pairing Secret 只用于首次授权某个 Node Public Key。

要求：

- 至少 128 bit CSPRNG 随机熵；
- 默认短有效期，建议 10 分钟；
- 单次成功使用后立即失效；
- Hub 限制失败尝试次数；
- 过期 / 使用后不能恢复；
- Hub 只存 Secret 的安全摘要 / verifier，不长期保存明文；
- 不能把短显示码本身设计成只有 6 位数字的全部安全熵。

UI 可以显示更友好的分组编码或 QR，但底层 Secret 必须保持足够随机性。

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

### 5.2 Node 验证 Hub

Node 连接前必须先建立 Hub 信任：

- 公共 CA TLS：正常验证证书链与 hostname；
- 自管理 TLS：使用用户从 Hub 本机获得的 TLS SPKI Fingerprint / Pairing Offer 进行 Pin；
- mDNS / 自动发现结果只能提供 endpoint，不能替代上述信任。

Node 在无法验证目标 Hub 身份时不得发送 Pairing Secret 或本机数据。

### 5.3 Node 提交 Pairing Request

Node 本地先生成：

```text
nodeId
Node key pair
```

Pairing Request 概念包含：

```text
nodeId
nodePublicKey
nodeKeyId
displayName
agentLensVersion
supportedProtocol
pairingSecret
```

Hub 验证 Secret 后：

- 注册 / 确认 Node；
- 保存 Node Public Key；
- 创建 `replicationStreamId`；
- 返回 Hub Identity Public Key / Hub ID；
- 返回协议 / 限制信息；
- 立即消费 Pairing Secret。

成功后长期认证不再使用 Pairing Secret。

## 6. Hub 自管理 TLS

没有域名 / 公共 CA 时，Hub 可以自动生成 TLS Material。

Alpha 原则：

- 默认生成长期 TLS Key + 自签证书；
- Node 在 Pairing 时 Pin TLS SPKI，而不是只记整张证书 hash；
- 正常续签同一公钥的证书不需要重新 Pair；
- TLS Private Key 轮换会改变 SPKI，不能静默接受；
- 如果未来支持安全轮换，必须由旧可信 Hub Identity 明确签名新的 TLS Key 或要求用户重新确认。

不要使用“忽略 TLS 证书错误”作为正式自托管方案。

## 7. 用户提供 TLS

Hub 可以使用用户提供的正式证书 / 私钥。

要求：

- 不改变 Hub Identity / hubId；
- Node 仍记录 Hub Identity；
- 若依赖公共 PKI，正常按 CA / hostname 验证；
- 配置错误时 Hub Replication Surface 应拒绝启动，而不是降级为明文 HTTP；
- 本机 `surface-http` 不受影响，继续 loopback。

## 8. 长期请求认证

Pairing 后，Node 使用私钥对 Replication 请求签名。

签名输入由 Wire Protocol 定义，至少绑定：

```text
HTTP method
path
timestamp
nonce
raw body SHA-256
nodeId
replicationStreamId（通过 header / server ownership 校验）
```

Hub 使用 Node Public Key 验证。

TLS 提供传输安全；Request Signature 提供长期 Node 身份证明、请求完整性与额外重放约束。两者不能互相替代。

## 9. 重放保护

Hub 至少验证：

- Timestamp 在允许时钟偏差范围；Alpha 建议默认 ±5 分钟；
- Nonce 在重放窗口内未使用；
- Batch Sequence 满足 contiguous cursor；
- 同 sequence 的重试内容摘要必须一致。

Nonce Cache 属于 Replication Control Plane，不进入 Canonical Store。

如果系统时间明显错误导致签名被拒绝，诊断必须明确提示 Clock Skew，而不是显示模糊“网络失败”。

## 10. Node Revocation

Hub 必须支持显式撤销 Node。

撤销语义：

```text
revoke node
 -> stop accepting future authenticated replication
 -> freeze active stream
 -> preserve already replicated history by default
```

撤销不等于：

- 删除 Hub 历史；
- 删除 Shared Entity；
- 删除 Node 本机数据；
- 清理用户 Agent 配置。

“撤销连接”和“删除该 Node 的历史数据”必须是两个显式操作。

## 11. Node Key Rotation

Node keyId 与 nodeId 分离。

### 有旧私钥

可以设计受旧 Key 签名保护的 Key Rotation：

```text
old key signs
  nodeId
  oldKeyId
  newKeyId
  newPublicKey
  rotationNonce
```

Hub 更新 active public key，nodeId / stream 可以继续保留。

### 旧私钥丢失 / 泄露

不能靠“我还是这个 nodeId”绕过认证。

必须：

```text
revoke old relationship
 -> explicit re-pair
 -> new key
 -> new replicationStreamId
```

是否复用 nodeId 需要 Hub 本机用户明确授权；不得自动接受同 nodeId + 新 key。

## 12. Hub Identity Rotation

Hub Identity 比 TLS Certificate 更稳定。

Alpha 不做无感 Hub Identity Rotation。

如果 Hub Identity Private Key 丢失 / 需要更换：

- 视为高风险管理操作；
- 默认要求 Node 重新确认 / 重新 Pair；
- 不允许因为 endpoint 相同就自动信任新 Hub Identity；
- 旧 Hub Identity 与新 Hub Identity 的历史迁移不通过模糊匹配完成。

以后若需要平滑 Rotation，必须单独定义由旧 Hub Identity 签名新 Identity 的双阶段协议。

## 13. Node Identity Clone Detection

复制整个 `~/.agent-lens/1.0` 目录可能复制 `nodeId` 和私钥，造成两台机器同时冒充同一个 Node。

Alpha Hub 必须至少检测异常信号：

- 同一 nodeId / key 同时从明显不同实例活跃；
- stream sequence 出现不可解释的分叉 / reuse conflict；
- Node metadata 在短时间发生强烈矛盾；
- 两个并发连接竞争同一 active stream。

检测到时：

```text
IDENTITY_NODE_CONFLICT
 -> freeze replication stream
 -> require explicit operator action
```

不能静默把两台机器的数据混成一个 Node。

后续应提供 `node identity reset`，为克隆实例生成新 nodeId / key / pairing relationship。

## 14. Pairing 与 Replication Policy

首次 Pairing 必须同时明确当前 Replication Policy：

```text
metadata-only
redacted
full
```

Hub 连接本身不能被解释成“允许上传本机全部历史数据”。

要求：

- Pairing UI / CLI 显示当前策略；
- `full` 仍强制遮蔽明确凭据；
- 策略扩大后，历史正文补传需要用户明确允许；
- 策略收紧不自动清除 Hub 已存在历史；Purge 独立执行。

详细规则见 `CAPTURE-POLICY.md`。

## 15. Hub Web 与 Replication Surface 分离

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

Hub 不因为已经有 Node Public Key / Pairing Secret 就顺带实现远程用户 Session、Cookie、RBAC。

远程 Web 以后单独设计身份认证与浏览器安全边界。

## 16. 网络发现

mDNS / LAN Discovery 未来可以发布：

```text
service name
hubId hint
endpoint
protocol hint
```

但 discovery 数据全部视为不可信提示。

建立信任仍依赖：

- TLS 验证 / SPKI Pin；
- Hub Identity；
- Pairing Secret。

Alpha 可以完全不实现 mDNS。

## 17. 日志与诊断脱敏

Hub / Node 运维日志可以记录：

```text
nodeId（可截断）
hubId（可截断）
streamId（可截断）
batchSequence
error code
protocol version
bytes / entity counts
```

默认禁止记录：

```text
Pairing Secret
Private Key
完整 Request Signature
Prompt / Tool 正文
Raw Replication Body
Authorization / Cookie / Token
```

诊断导出必须默认脱敏。

## 18. 安全验收不变量

至少验证：

- Pairing Secret 过期 / 使用后不能再次配对；
- 未配对 Node 无法 Handshake / Batch；
- 已撤销 Node 无法继续上传；
- 自管理 TLS 遇到 SPKI 不匹配必须失败；
- mDNS 伪造不能直接建立信任；
- 捕获合法请求后重放会被 Nonce / Sequence 拒绝；
- 修改 Raw Body 后签名验证失败；
- 同 nodeId + 非授权新 key 不能自动替换旧 key；
- 两个实例竞争同一 Node / Stream 时进入 identity conflict；
- Private Key / Pairing Secret 不进入 Canonical DB、Replication Batch、普通日志或资产备份；
- Replication Credential 不能访问本机无认证 Web Surface；
- Hub TLS 配置失败时不得降级成明文网络接口。

## 19. 当前非目标

Alpha 不实现：

- 用户账号体系；
- Team / Organization / RBAC；
- OAuth / SSO；
- 浏览器远程登录；
- 多 Hub 信任网；
- 自动 Hub Identity 无感轮换；
- HSM / TPM 强依赖；
- 公有云控制平面。
