# Source 数据完整性契约

AgentLens 1.0 的 Source 层遵循一条硬约束：**宿主已经写出的原生事实，不能因为 AgentLens 暂时不认识就被 Source Adapter 丢掉。**

## 数据边界

1. Source Adapter 负责读取宿主原生记录，并尽可能完整地放入 `SourceRecord.payload`。
2. Source Adapter 不通过字段白名单决定“哪些原生字段值得保存”。
3. 所有持久化前的递归脱敏、字符串限长、数组/对象上限由中央 `CapturePolicyService.sanitizeSourceRecord()` 统一执行。
4. Normalizer 只负责解释语义：认识的事实映射为稳定的 `CanonicalObservation`；暂时不认识的类型映射为 `unknown`，并在 `rawPayload` 中保留安全后的原生内容。
5. `CanonicalObservation` 不是原生记录的完整副本。完整回查以 `SourceRecord + Evidence` 为准，稳定跨 Agent 语义以 `CanonicalObservation` 为准。

## 安全限制

中央 Capture Policy 始终执行结构保护：敏感键在持久化前脱敏；文本按采集档位统一限长；数组和对象统一限制项目数；循环引用、超深结构和非 JSON 值转换为安全占位；`off` 档位不会因为完整保存要求被绕过。

## Parser 升级与重放

- 原始字段仍在 SourceRecord：优先幂等 replay，只重建 Canonical Observation / Projection。
- 旧 Parser 曾在 Source 层裁字段：重新扫描宿主原生数据；SourceRecord ID 保持确定性，使重扫表现为 upsert 而非重复记录。
- 宿主原始数据已不存在：不得合成缺失事实；Coverage 标记 partial/unavailable，并保留现有 Evidence。

本契约由 Issue #43 建立，后续新增 Source 和原生事件类型都必须遵守。
