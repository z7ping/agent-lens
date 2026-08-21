# AgentLens 1.0 Daemon

这是 AgentLens 1.0 Clean Rebuild 的运行入口。

Daemon 负责创建 Cordis Application，并在 Composition Root 中装配 Core Services、Storage、Source、Projection 与 HTTP Surface 等运行时插件。Source / Storage / Surface 的插件入口采用 Cordis-native 方式；Core Domain 与核心 Contract 不依赖 Cordis。

0.x 根目录 `server/` 仅保留在 Git 历史中，不属于 1.0 Runtime Path。
