from pathlib import Path

p = Path('docs/1.0/IMPLEMENTATION-STATUS.md')
text = p.read_text()
start = text.index('## 10. 多机 Hub')
end = text.index('## 11. 关键实现不变量')
section = '''## 10. 多机 Hub

状态：**H1-H11 已实现；当前进入 H12 Tombstone 删除生命周期。Replication Transport、HTTPS、TLS、Pairing 仍未实现且继续延期。**

当前已实现：

- H1 Node Runtime：持久 Node Identity、`standalone / node / hub / pure-hub` Profile 与 capability-driven composition；
- H2 Replication Core：Entity Scope、ReplicaKey、SharedRoot/SharedGroup、Portable Identity；
- H3 R1 Protocol：Handshake、Entity/Batch/Tombstone Wire DTO、Typed Ref、Availability、确定性 Hash、Sequence/ACK 决策；
- H4 Replication Policy / History Boundary：`metadata-only / redacted / full`、`include-existing / from-now`、字段白名单与最小依赖；
- H5 Durable Replication State：Pending、Frozen Batch、ACK、Stream/Generation、Reconciliation 与重启恢复；
- H6 Node Replica Generation：Canonical Change Journal 单调 revision、固定 Bootstrap high-water、持久进度、Canonical -> Wire -> Pending/Frozen、Typed Ref DAG 与跨页依赖闭包；
- H7 Hub Remote Replica Store：SQLite schema v10、staged/active/retired Generation、事务化 R1 Batch Import、Hub 重算 ReplicaKey/SharedKey/Scope、exact retry、连续 ACK 与整批 rollback；
- H8 Unified Read：Local Canonical + active Remote Replica，Remote 使用 opaque ReplicaKey，staged/retired 不可见，Availability 与 public references 保真；
- H9 Availability-aware Hub Review：独立 Hub Review DTO/Projection，`value/null/redacted/omitted` 不强转为 Local 完整 Observation；
- H10 loopback Surface / Remote Review detail：`GET /api/v1/hub/review/:opaquePublicId` 与 `/review/hub/:ReplicaKey`，仍只监听 `127.0.0.1`；
- H11 Remote Session Discovery：`GET /api/v1/hub/review`、Local + active Remote LogicalSession 列表、现有任务复盘左栏直接混排本机/远程会话，并使用轻量 Node 来源标识。

H11 列表筛选保持 fail-closed：Remote Summary 当前没有可靠 source/project/error-status 维度时，不伪造这些筛选结果；时间范围、标题和 Node 搜索只使用已同步且可证明的数据。Remote `redacted/omitted` 继续显式显示，不映射为空字符串、空对象或假时间。

当前仍**没有**实现：

```text
Node -> Hub HTTP/HTTPS Replication Transport
Pairing / TLS / request signatures / serverProof
Remote Web Login / Remote Control
Tombstone Node generation + Hub application lifecycle
Remote file backup / pull
HA / Multi-Hub / Federation
```

H11 最终代码候选 `26e567c00b9c750548327d3eeb9cbb757a05b001` 已通过 Linux / macOS / Windows 主 CI 的 Typecheck、Test 与 Build；Windows 同时通过 Desktop package、Smoke、共享 Hook Dispatcher、npm lifecycle 与 npm package contents。

下一阶段 H12 只补 Tombstone 删除语义和本地 durable/import/read 生命周期，继续不增加新的网络可达面。

长期设计只维护在以下文档：

- `docs/1.0/HUB-DESIGN.md`：Hub 当前有效系统设计；
- `docs/1.0/HUB-REPLICATION-PROTOCOL.md`：R1 长期协议语义；
- `docs/1.0/HUB-PAIRING-SECURITY.md`：配对、安全、数据出站边界；
- `docs/1.0/HUB-OPERATIONS.md`：用户 / 运维生命周期；
- `docs/adr/0007-multi-machine-hub-local-first-canonical-replication.md`：关键选择及原因。

跨会话工作状态以 `agent-swe/work-state.yaml` 为准，真实完成情况以代码和测试为准。

'''
p.write_text(text[:start] + section + text[end:])
