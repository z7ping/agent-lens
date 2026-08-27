# AgentLens 1.0 Hub Pairing 与安全边界

更新日期：2026-08-27  
状态：**Alpha 安全设计冻结，尚未实现**  
上位设计：`docs/1.0/HUB-DESIGN.md`  
协议语义：`docs/1.0/HUB-REPLICATION-PROTOCOL.md`  
仓库总安全边界：`SECURITY.md`

本文是 Hub 专项安全知识的唯一长期入口，负责身份、配对、TLS、密钥、重放保护、Clone Detection、数据出站边界与 trusted-node 限制。它不为现有本机 Web API增加网络认证，也不把 Hub 变成远程管理平台。

## 1. 威胁模型

Alpha 至少防御：

- 未配对机器上传；
- 已撤销 Node 继续上传；
- 伪造 endpoint / discovery 诱导 Node；
- 中间人替换自签 Hub；
- endpoint 相同但服务器已经不是原 Hub；
- 请求重放 / Header-Body 篡改；
- Pairing Secret 被长期复用；
- 克隆数据根造成相同 Node Identity 真并发；
- 私钥 / Secret 泄入 Canonical、日志或普通备份；
- 已配对但被攻陷 Node 的资源滥用。

Alpha 不声称防御已经完全控制 Node / Hub OS 管理员权限的攻击者，也不是 Remote Attestation 系统。

## 2. 三类身份必须分离

### Node Identity

```text
nodeId = persistent random UUID
Node key pair = long-term request identity
```

nodeId 不等于 hostname / Host.id / Pairing Relationship。

### Hub Identity

```text
hubId
Hub key pair
```

Hub Identity Key 必须实际签名 Pairing Receipt / Handshake serverProof，不能只是 metadata。

### TLS Identity

TLS Certificate 负责传输端点；Hub Identity 负责长期产品信任身份。证书续期不等于换 Hub。

## 3. 本地密钥材料

Node / Hub / TLS private material：

- 使用当前 OS 用户最小权限 / ACL；
- 不进入 Canonical Observation / Evidence / SourceRecord；
- 不进入普通 Asset Backup；
- 不进入 Replication Batch；
- 日志只输出截断 keyId / fingerprint；
- npm / Desktop 共用同一默认数据根下的身份材料。

未来可接 OS Credential Store，但 Alpha 不强依赖某个平台。

## 4. Pairing Secret 与 Key Possession

Pairing Secret：

- 至少 128 bit CSPRNG；
- 短有效期；
- 成功一次即失效；
- 尝试次数受限；
- Hub 不长期存明文；
- 短显示码不能是全部安全熵。

Pair Request 同时提交 Node Public Key 与 `nodeProof`，证明客户端持有对应 Private Key。

Pair Secret 证明“用户授权这次接入”；nodeProof 证明“提交者持有这把 Node Key”。

## 5. Pairing 流程

```text
Hub 创建 Pairing Offer
 -> Node 验证 TLS / Hub Identity hint
 -> Node 提交 Secret + Public Key + nodeProof
 -> Hub 注册 Node / 创建 Stream
 -> Hub 消费 Secret
 -> Hub Identity Key 签 Pairing Receipt
 -> Node 验证并保存 Receipt
```

Pairing Receipt 至少绑定：Hub、Node、Node Key、Stream、时间与 Protocol Range。

Hub 必须拒绝把自己的 local nodeId 配对为 Remote Node。

## 6. Handshake Hub Proof

每次建立 Replication Session，Node 提供 client nonce；Hub 使用 Hub Identity Key 对本次会话关键状态签 `serverProof`。

Node 只有同时满足：

```text
TLS / SPKI valid
Pairing Receipt valid
serverProof valid
```

才发送 Replication Data。

## 7. TLS

### 自管理 TLS

Pin SPKI，不 Pin 整张证书；同 Key 续签无需 Re-pair。TLS Key 变化不能静默接受。

### 公共 CA

正常验证 CA 与 hostname。

无论哪种模式，TLS 配置失败都不得降级为明文 HTTP。

## 8. 长期请求认证与重放保护

R1 Request Signature 至少绑定：

```text
method / path
hubId / nodeId / streamId / keyId
timestamp / nonce
raw body SHA-256
```

Hub 验证注册 Public Key、ownership、timestamp、nonce、body hash。

重放保护组合：

```text
timestamp window
nonce cache
contiguous sequence / ACK
same-sequence same-hash
```

Clock Skew 产生明确安全诊断，不被误报为普通网络失败。

## 9. Node Revocation 与 Key Rotation

### Revocation

冻结 Stream、拒绝未来上传，默认保留已有 Remote Replica 与 Shared provenance。

Revocation 不等于 Delete History。

### Node Key Rotation

旧 Key 仍可用时，由旧 Key 授权新 Key；nodeId 可保留。

旧 Key 丢失 / 泄露时，采用 revoke + explicit re-pair + new stream。不得静默把未知新 Key 接到旧 Node。

### Hub Identity Rotation

Alpha 不做无感 Rotation。Hub Identity Key 丢失或更换时，Node 必须重新确认 / Re-pair；endpoint 相同不能绕过。

## 10. Clone Detection

每次 Daemon 启动生成临时 `runtimeInstanceId`。

强冲突信号：

- 同 nodeId / stream 真正并发不同 runtimeInstance；
- sequence 分叉；
- 同 stream 竞争不同 immutable Batch。

弱信号：

- IP / hostname / metadata 变化；
- sleep / wake 旧连接残留。

弱信号只做 diagnostics，不能单独 freeze。强冲突进入 `IDENTITY_NODE_CONFLICT`。

## 11. Replication Policy 与数据暴露

Capture Policy 是 Local Canonical 上限；Replication Policy 只能进一步收紧。

### metadata-only

默认允许：

- Node / Agent / Tool / Session 结构；
- 时间与必要关系；
- 清洗后的 Project / Repository Portable Identity；
- 用于 Shared Identity 的非凭据 metadata。

默认禁止：

- Prompt / Tool body；
- SourceRecord payload；
- 完整 Workspace path；
- executable / configRoot / dataRoot 等本机敏感路径。

因此 `metadata-only` **不是匿名模式**。

### redacted

允许必要正文 / 路径进入出站转换，但必须执行：

- credential 强制遮蔽；
- 路径脱敏；
- 敏感字段清洗；
- 内容限长。

### full

只允许发送 Local Capture 已经保存且用户允许复制的普通业务正文 / 必要路径；凭据、Secret、Private Key 仍强制排除。

## 12. Repository / Asset Identity 清洗

Portable Identity 进入 Wire / SharedKey / Log 前必须移除：

```text
userinfo
credential/token
query
fragment
```

本机绝对路径不能作为 Shared Project Identity。

Hub 重算 SharedKey 只能证明算法一致，不能证明 Node 现实中拥有该 Repository / Asset。

## 13. History Scope 与安全边界

首次连接必须明确：

```text
Policy: metadata-only | redacted | full
History: from-now | include-existing
```

连接 Hub 不能默认上传整个本地数据库。

`from-now` 的 Dependency Closure 只能携带建立 Boundary 后新事实引用图所需的最小字段；不能借依赖补齐偷传 Boundary 前正文、完整路径或旧会话元数据。

## 14. Local Web 与 Replication Surface

```text
Local Web/API
 -> 127.0.0.1:56789
 -> 不因为 Hub 改成网络监听

Replication Surface
 -> 独立 authenticated HTTPS
```

Replication Credential 不能用于 Local Web 登录。

Alpha 不内建 Remote Web Login；Headless Hub 通过本机 / SSH CLI 或用户自己建立可信 loopback tunnel 管理。

## 15. Discovery 不建立信任

mDNS / LAN Discovery 最多提供 endpoint hint。

正式信任依赖：

```text
TLS / SPKI
Hub Identity
Pairing Secret
Pairing Receipt
Handshake Proof
Node Request Signature
```

## 16. 日志与诊断脱敏

可以记录：

- 截断 nodeId / hubId / streamId；
- sequence；
- error code；
- protocol / entity version；
- bytes / entity count；
- clock skew。

禁止记录：

- Pair Secret；
- Private Key；
- 完整 Signature；
- Prompt / Tool 正文；
- Raw Batch；
- Authorization / Cookie / Token；
- 带凭据的原始 Repository URL。

## 17. Hub 聚合数据安全半径

Hub 聚合多个 Node 的数据，风险高于单机：

- 数据根只允许当前 OS 用户；
- Alpha 不声称 SQLite 透明加密；
- full 用户优先依赖系统磁盘加密；
- Hub Identity / Pairing Trust / Replica Data 的恢复边界分开；
- 关闭 Hub 或撤销 Node 不自动清除已复制内容。

若用户希望清除 Hub 已有敏感内容，必须是独立 Purge / Delete 操作，而不是 Policy Setting Change 的隐含副作用。

## 18. Trusted-node 真实性边界

Alpha 是：

```text
single user
+ explicitly paired trusted Nodes
```

密码学能证明：

- 请求来自某把已配对 Node Key；
- 请求在传输过程中未被篡改；
- Shared Identity 计算符合协商算法。

密码学不能证明：

- Node 真的拥有它声称的 Git Repository；
- Tool / Prompt / Session 一定来自真实上游 Agent；
- 已被完全攻陷的 Node 没有伪造格式合法的 Canonical State。

因此必须保留 originNodeId / assertion provenance；Node A 不得修改 Node B origin；Shared Group 不抹掉各 origin。

## 19. 资源滥用保护

即使已配对 Node 也必须限制：

- HTTP Body；
- 单 Entity 大小；
- Batch Entity 数量；
- 每 Node rate / concurrency；
- Pairing 尝试；
- Hub disk low-water mark。

资源压力只暂停 / 降速 Replication，不影响 Node Local Pipeline。

## 20. Alpha 安全冻结不变量

- Pair Secret 过期 / 消费后不可复用；
- nodeProof 无效不能注册 Key；
- Pairing Receipt / serverProof 可验证；
- 未配对 / 已撤销 Node 不能上传；
- SPKI / Hub Identity mismatch 阻断；
- Discovery 不能直接建立信任；
- Replay / Header / Body 篡改失败；
- TLS 错误不降级 HTTP；
- metadata / IP 变化不能单独 Clone Freeze；
- 真并发 clone 进入 hard conflict；
- Secret / Private Key 不进入普通数据链；
- metadata-only 不宣传匿名；
- Hub 重算 SharedKey mismatch 时拒绝；
- trusted-node 不被描述成 Remote Attestation；
- Local Web 继续 loopback；
- 不提供 Remote Execution。

## 21. 当前非目标

用户账号 / Team / RBAC、OAuth / SSO、Remote Browser Login、多 Hub 信任网、无感 Hub Identity Rotation、HSM / TPM 强依赖、公有云控制面、数据库透明加密、Remote Attestation、Repository Ownership Proof。
