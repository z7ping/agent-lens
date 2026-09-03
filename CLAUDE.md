# CLAUDE.md

Claude Code 修改 AgentLens 前必须先阅读并遵守 [`AGENTS.md`](AGENTS.md)。

尤其注意：

- 当前为 `1.0.0-alpha.3` 稳定化 / 表现层收敛，不扩无关功能；
- 未经明确要求不得合并 `main`、发布 npm 或创建 Release；
- 所有 Web UI 修改必须遵守 #55 的统一组件契约；
- 已有 Primitive / Task Surface 组件时不得重新实现平行控件；
- 正常可见字号不得低于 12px，不新增临时覆盖层、一次性断点或 `!important` 兜底；
- 高保真设计资料只在 `z7ping/product-internal` 维护。
