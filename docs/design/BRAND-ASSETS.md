# AgentLens 品牌图标资产

AgentLens 1.0 使用同一套“轨迹汇聚到镜头焦点”的品牌图标：左侧两个智能体/数据节点沿路径进入右侧观察镜头，橙色焦点表示被捕获、聚合并可复盘的关键活动。

本轮确认的图标方向以蓝青渐变圆角底、白色轨迹与镜头、青色/蓝紫来源节点和橙色焦点为唯一基线，不再使用此前深蓝 `A + L + Lens` 图标。

## 源资产

| 路径 | 用途 | 规格 |
| --- | --- | --- |
| `packages/web/public/agentlens-icon.svg` | 主品牌图标 | 1024 viewBox，可无损缩放 |
| `packages/web/public/agentlens-icon-small.svg` | favicon / 极小尺寸 | 64 viewBox，加粗轨迹与镜头几何 |
| `scripts/prepare-windows-icon.ps1` | Windows 图标派生器 | 从同一设计几何生成 PNG / ICO |

## Windows 派生规格

Windows 资产由 `prepare-windows-icon.ps1` 在桌面开发启动和打包前生成，不提交派生二进制文件。

| 资产 | 使用位置 | 尺寸 |
| --- | --- | --- |
| `icon-app.ico` | EXE、安装器、快捷方式 | 16 / 20 / 24 / 32 / 40 / 48 / 64 / 128 / 256 px |
| `tray.ico` | Windows 托盘 | 16 / 20 / 24 / 32 / 40 / 48 px |
| `icon-window.png` | Electron 主窗口 | 256×256 PNG |
| `icon-win.png` | Windows 兼容/诊断资源 | 512×512 PNG |

其中 16–48 px 使用专门的小尺寸几何：轨迹更粗、镜头更大、节点更明确；64 px 以上使用完整图形。不能再用一张 512px 图片直接缩到托盘尺寸。

## Web 使用

- 浏览器 favicon：`agentlens-icon-small.svg`，`sizes="any"`。
- 页面 Header 品牌标记：`agentlens-icon.svg`。
- v2.1 高保真原型：与正式 Web 共用 `agentlens-icon.svg`，不单独维护另一套 Logo。

## 规则

- 所有入口必须保持“两个来源节点 → 两条轨迹 → 镜头焦点”的同一识别语义，不允许自行重新绘制另一套品牌符号。
- 圆角图标外围必须透明；禁止为了规避 Windows 透明资源问题再次填充黑色背景。
- Windows EXE / 安装器必须使用多尺寸 ICO，不再直接把单张 PNG 交给系统缩放。
- 托盘必须使用独立的小尺寸 ICO 帧；16–48 px 不能复用未经优化的大图缩略结果。
- 修改品牌资产时必须同步检查 Web favicon、Header、桌面窗口、托盘、EXE/安装器和高保真原型。
- `npm run check:brand-assets` 负责阻止旧 `favicon.*`、旧 `icon.png` 兜底或错误尺寸矩阵重新进入当前实现。
