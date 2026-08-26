# AgentLens Logo 存档

本目录用于保存 AgentLens 品牌设计存档。**当前正式图标的唯一主源不在本目录**，而是：

```text
docs/design/brand/agentlens-icon-master.svg
```

## 2026-08-26 新主母版

当前正式图标已切换到 `docs/design/brand/agentlens-icon-master.svg`。该母版使用 1254×1254 矢量坐标，保留蓝青圆角底、双端节点、两条汇聚带、白色环体和橙色中心。

本目录中的以下文件只作为稳定的品牌引用 / README 兼容路径，并要求与新主母版逐字同步：

| 文件 | 说明 |
| --- | --- |
| `agentlens-logo.svg` | README 与品牌存档主引用 |
| `agentlens-logo-small.svg` | 旧小尺寸引用兼容路径；当前不再维护独立几何 |
| `concepts/` | 2026-08-25 的历史候选方案，只用于追溯，不参与当前运行时品牌选择 |

## 正式运行资产

- `packages/web/public/agentlens-icon.svg`：正式 Web Header。
- `packages/web/public/agentlens-icon-small.svg`：正式 Web favicon。
- `docs/design/mockups/v2/`：通过共享脚本读取正式 Web 图标，因此与运行时代码保持同源。
- Windows PNG / ICO：由 `scripts/prepare-windows-icon.ps1` 按新母版坐标和配色派生。
- 完整同步规则见 `docs/design/BRAND-ASSETS.md`。

## 存档规则

- `docs/design/brand/agentlens-icon-master.svg` 是当前品牌图形事实源。
- `docs/brand/logo/agentlens-logo*.svg` 不再独立演进，必须与主母版同步。
- `docs/brand/logo/concepts/` 只保存历史探索，不得被正式程序引用。
- 正式程序继续使用各平台运行资产，不直接耦合文档目录。
- 后续如果再次定稿 Logo，先更新主母版，再同步 Web、原型、Windows 派生器和本目录兼容资产。
- 不保存一次性导出脚本、构建产物或无意义的多份 PNG 缩放副本。
