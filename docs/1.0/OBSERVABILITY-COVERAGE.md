# AgentLens 1.0 可观测完整度

更新日期：2026-08-24  
状态：1.0 P0 稳定化基线

AgentLens 必须区分三个不同问题：

1. **来源是否允许采集**：由 `CapturePolicyService.isSourceEnabled(sourceId)` 决定；
2. **来源理论上能观察什么**：由 `ObservationCapability` 声明；
3. **某次实际采集覆盖了什么时间范围**：由 `ObservationCoverage` + Evidence 证明。

不得把“插件已注册”“本机曾检测到”“Source 声称支持某能力”直接等价成“当前正在完整采集”。

## 1. Source 状态语义

正式 Surface 中：

- `supported`：AgentLens 内置 / 注册了该 Source；
- `enabled`：当前采集策略允许该 Source 进入 Detect / History / Runtime / Asset；
- `detected`：数据库中存在该产品的 Installation 事实；
- `capabilities`：当前已启用并完成 Source 能力声明后，运行时掌握的可观测能力。

因此，某个来源完全可能同时满足：

```text
supported = true
enabled = false
detected = true
```

含义是“AgentLens 支持它、以前已经识别到本机安装，但当前用户关闭了采集”。Surface 不得再把所有已注册 Source 固定显示为 `enabled=true`。

## 2. Capability 只表达能力边界

`ObservationCapability` 描述 Source 的能力上限：

```text
available
partial
experimental
unavailable
not-applicable
```

同时保留：

- `captureModes`：`history`、`runtime-hook`、`native-tail`、`static-scan` 等实际采集渠道；
- `reason`：为什么只能部分观察、为什么不可用。

能力声明不是数据完整度证明。例如：

```text
transcript = available
```

只表示 Source 的已验证实现能够读取对话，并不表示任意历史时间段都已经成功读完。

## 3. Coverage 必须有实际边界

History Runner 只有在真实读到 SourceRecord 后，才自动生成时间 Coverage：

```text
首条实际记录时间
    ↓
[from, to]
    ↑
末条实际记录时间
```

自动 Coverage 的 `from / to` 必须来自实际 SourceRecord；不能因为 Source 声称 `available` 就凭空生成覆盖窗口。

P0 收口后，自动 History Coverage 还必须引用窗口首尾 Source Evidence。这样一条 `complete` / `partial` Coverage 不只是一个状态字符串，而能回答：

> “为什么 AgentLens 认为这个时间段被覆盖？”

如果历史读取没有产生任何 SourceRecord，则可用能力保持 `unknown` Coverage，而不是伪造 `complete`。

## 4. Runtime 为什么不自动声称 complete

Runtime Capture 是开放区间。Daemon 启动实时采集时只有“开始”，通常没有一个可证明的最终 `to`；中间还可能发生 Agent 未运行、Hook 未启用、原生文件没有变化、进程被系统终止等情况。

因此 1.0 P0 不做下面这种虚假声明：

```text
Runtime 启动
→ capability=complete
→ 假装从此以后所有事件都完整
```

Runtime 完整度当前由两层事实表达：

- Source Capability 的 `captureModes` 表明是否存在 `runtime-hook` / `native-tail`；
- 每个真实 Runtime Observation 自带 Evidence，说明该具体事实通过什么通道被观察到。

后续如果要建立严格的 Runtime 连续覆盖区间，必须引入可验证的心跳 / gap 语义后再做；这不属于本轮 P0。

## 5. Evidence 主链

当前 1.0 必须保持：

```text
SourceRecord
  ↓
EvidenceCandidate
  ↓
Evidence
  ├─ captureMethod
  ├─ derivation
  ├─ confidence
  ├─ sourceLocator
  ├─ parserVersion
  ├─ eventTime / capturedAt
  └─ missingReason
  ↓
Canonical Observation / Coverage
  ↓
Projection / Protocol / Web
```

Timeline / Review 已保留 Observation Evidence。Coverage 的自动历史窗口也从本轮开始保留首尾 Evidence 引用。

## 6. 禁止事项

不得为了把“完整度”做得好看而：

- 对未启用 Source 执行 Detect；
- 没读到任何记录却生成 `complete` Coverage；
- 把 Capability=`available` 当成实际数据完整；
- 把开放中的 Runtime Capture 直接标成无限期 `complete`；
- 丢掉 `partial / unavailable` 的 `reason`；
- 用 Projection 猜测 Source 没有证明的隐藏信息；
- 恢复 0.x timeline / Adapter Runtime / 轮询式总线来填补“看起来缺数据”的问题。

P0-2 的目标不是扩采集面，而是保证 AgentLens 对“我能看到什么、我实际看到了什么、我为什么这么判断”的表达可信。
