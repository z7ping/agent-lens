# @agent-lens/runtime-cordis

AgentLens 1.0 的 Cordis 运行时公共层。

AgentLens 1.0 本身是 Cordis Application；Source、Storage、Surface 等运行时扩展入口直接采用 Cordis-native Plugin，不再通过通用 AgentLens Adapter 二次包装。

本包负责共享的 Cordis Context typing、Plugin 元数据 / API 版本辅助能力和兼容性测试。`@agent-lens/core`、Core Services、Repository Contract、Parser / Normalizer 与 Protocol DTO 保持框架无关。

Daemon 通过本包一次性准备已注册 Source：单次探测后先启动实时采集，再并行执行历史摄取与资产发现；各 Source 的阶段失败相互隔离。当前按请求计算的 Projection 不作为 Cordis Context Service 注册。

`@deepseek-ai/cordis` 固定精确版本 `4.0.1`；升级前必须先通过运行时兼容性测试。
