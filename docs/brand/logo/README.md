# AgentLens Logo 存档

本目录用于保存 AgentLens 已确认的品牌 Logo 设计源，不作为运行时资产目录。

## 2026-08-25 定稿

当前品牌符号采用“轨迹汇聚到镜头焦点”的设计：

- 左侧两个来源节点代表不同智能体、会话或数据来源。
- 两条白色轨迹向右汇聚，表达“跨来源采集、统一归一化、任务复盘”。
- 右侧双层镜头结构表达 Lens（观察 / 检视）。
- 橙色焦点代表被捕获并聚合的关键活动。
- 蓝青渐变底强调本地工具、技术感与可观察性，同时保持桌面和 Web 图标的小尺寸辨识度。

### 设计源

| 文件 | 说明 |
| --- | --- |
| `agentlens-logo.svg` | 主 Logo，1024 viewBox，用于中大尺寸品牌场景 |
| `agentlens-logo-small.svg` | 小尺寸优化版，64 viewBox，加粗轨迹、节点与镜头几何，用于 favicon / 托盘等 |

### 正式运行资产

设计存档与正式运行资产保持同源，但用途不同：

- `packages/web/public/agentlens-icon.svg`：正式 Web 主品牌图标。
- `packages/web/public/agentlens-icon-small.svg`：正式 Web 小尺寸图标。
- Windows PNG / ICO：由 `scripts/prepare-windows-icon.ps1` 基于同一设计派生。
- 详细品牌资产规则见 `docs/design/BRAND-ASSETS.md`。

## 存档规则

- `docs/brand/logo/` 保存已确认设计源和历史版本，不由构建流程直接消费。
- 正式程序继续引用各平台运行资产，不改为直接引用本目录。
- 后续 Logo 调整如正式定稿，应在本目录新增版本或更新存档说明，并同步正式运行资产与 `docs/design/BRAND-ASSETS.md`。
- 不保存一次性导出脚本、构建产物或无意义的多份 PNG 缩放副本。
