# AgentLens 品牌图标资产

AgentLens 1.0 使用统一品牌图标，不在不同入口维护不同视觉方案。

## 当前资产

| 路径 | 用途 | 规格 |
| --- | --- | --- |
| `apps/desktop/assets/icon.png` | Windows 应用、窗口、安装包主图标源 | 512×512 PNG，透明背景 |
| `apps/desktop/assets/tray.ico` | Windows 托盘专用多尺寸资源 | 16 / 20 / 24 / 32 px |
| `packages/web/public/favicon.ico` | 浏览器标签页兼容图标 | 16 / 32 / 48 px |
| `packages/web/public/favicon.png` | 浏览器高分辨率 PNG 图标 | 128×128 PNG，透明背景 |

## 规则

- 所有派生图标必须来自当前确认的 AgentLens 主 Logo，不允许各入口自行重新绘制。
- Windows 主应用图标保留 512×512 PNG，交给 `electron-builder` 生成应用所需资源。
- Windows 托盘优先使用包含多 DPI 尺寸的 ICO；16 / 20 / 24 / 32 分别覆盖常见 100% / 125% / 150% / 200% 缩放。
- Web 同时提供 ICO 与 PNG：ICO 负责传统浏览器和小尺寸，PNG 负责高分辨率场景。
- 修改 Logo 时必须同步检查桌面图标、托盘图标、Web favicon 的实际小尺寸效果，不能只检查 512×512 原图。

## 当前设计方向

主 Logo 采用已确认的极简 `A + L + Lens` 组合：深蓝主体、亮蓝镜片/强调色、透明背景。目标是保证桌面快捷方式、托盘和浏览器标签页在小尺寸下仍具备可识别性。
