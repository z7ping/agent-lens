# AgentLens 品牌图标资产

AgentLens 当前唯一正式图标主源为：

```text
docs/design/brand/agentlens-icon-master.svg
```

该文件是 2026-08-26 确认的新矢量主母版。后续 Web、最新版高保真原型、README 品牌存档以及 Windows 桌面派生资产都必须以它为准，不再允许各入口独立重绘一套“近似 Logo”。

## 源资产与同步关系

| 路径 | 用途 | 规则 |
| --- | --- | --- |
| `docs/design/brand/agentlens-icon-master.svg` | **唯一矢量主母版** | 品牌图形的事实源 |
| `packages/web/public/agentlens-icon.svg` | Web Header | 与主母版逐字同步 |
| `packages/web/public/agentlens-icon-small.svg` | Web favicon | 与主母版逐字同步，不维护另一套小图形 |
| `docs/brand/logo/agentlens-logo.svg` | README / 品牌存档兼容路径 | 与主母版逐字同步 |
| `docs/brand/logo/agentlens-logo-small.svg` | 品牌存档兼容路径 | 与主母版逐字同步 |
| `scripts/prepare-windows-icon.ps1` | Windows PNG / ICO 派生器 | 按主母版的 1254 坐标、配色和几何同步绘制 |

`docs/brand/logo/concepts/` 继续只保存历史候选，不参与当前运行时品牌选择。

## Web 与最新版原型

- 浏览器 favicon：`/agentlens-icon-small.svg`。
- 正式 Web Header：`/agentlens-icon.svg`。
- `docs/design/mockups/v2/` 是当前唯一高保真基线；共享 `assets/app.js` 继续读取正式 Web 的 `packages/web/public/agentlens-icon.svg`，因此原型与正式代码使用同一份已同步主母版，不再另外复制一份原型 Logo。
- 修改主母版后，必须同步两个 Web SVG 运行资产，否则 `npm run check:brand-assets` 失败。

## Windows 派生规格

Windows 资产由 `prepare-windows-icon.ps1` 在桌面开发启动和打包前生成，不提交派生二进制文件。

| 资产 | 使用位置 | 尺寸 |
| --- | --- | --- |
| `icon-app.ico` | EXE、安装器、快捷方式 | 16 / 20 / 24 / 32 / 40 / 48 / 64 / 128 / 256 px |
| `tray.ico` | Windows 托盘 | 16 / 20 / 24 / 32 / 40 / 48 px |
| `icon-window.png` | Electron 主窗口 | 256×256 PNG |
| `icon-win.png` | Windows 兼容/诊断资源 | 512×512 PNG |

所有尺寸都从同一套新母版几何派生，禁止继续保留旧版蓝青轨迹图的硬编码坐标。多尺寸 ICO 仍然保留，让 Windows 在不同 DPI / 托盘尺寸下选择合适帧，而不是让系统临时缩放单张 PNG。

## 当前图形约束

- 新母版采用 1254×1254 坐标系。
- 蓝青背景、白色环体与汇聚带、青色/蓝色端点、橙色中心都属于正式图形。
- 主母版当前包含深色外角与细描边；这是新母版的一部分，平台派生时不得擅自透明化、改色或恢复旧版圆角处理。
- 不允许再从 `concepts/`、旧截图或旧 PowerShell 几何生成正式图标。
- Windows EXE / 安装器必须使用多尺寸 ICO。
- 托盘必须使用多尺寸 ICO。
- 修改品牌资产时必须同步检查 Web favicon、Header、最新版高保真原型、README 品牌存档、桌面窗口、托盘、EXE / 安装器。
- `npm run check:brand-assets` 负责校验主母版与运行时 SVG 完全一致，并阻止旧图形重新进入当前实现。
