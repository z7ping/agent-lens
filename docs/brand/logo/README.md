# AgentLens 品牌图标

本目录只保留 AgentLens 已确认并参与正式产品/发行的品牌源资产。历史候选与设计过程已迁入私有产品资料库，不作为公开代码仓库的工程输入。

## 正式主母版

唯一正式图标母版：

```text
docs/brand/logo/agentlens-icon-master.svg
```

规格：1254 × 1254 矢量坐标，蓝青圆角底、双端节点、两条汇聚带、白色环体和橙色中心。

以下兼容引用必须与主母版逐字节一致：

- `docs/brand/logo/agentlens-logo.svg`
- `docs/brand/logo/agentlens-logo-small.svg`

## 正式运行资产

- `packages/web/public/agentlens-icon.svg`：Web Header 图标。
- `packages/web/public/agentlens-icon-small.svg`：Web favicon。
- `apps/desktop/build/icon.svg`：桌面构建 SVG。
- Windows PNG / ICO：由 `scripts/prepare-windows-icon.ps1` 按正式几何与配色派生。
- macOS ICNS：由 `scripts/prepare-macos-icon.sh` 从桌面构建 SVG 派生。
- Linux：直接使用桌面构建 SVG。

`scripts/check-brand-assets.mjs` 负责验证主母版、Web、文档兼容引用与桌面构建 SVG 保持一致，并检查各平台派生链没有回退到旧品牌资产。

## 规则

1. 正式图标几何只能从 `agentlens-icon-master.svg` 演进。
2. 不在 React、Electron 或平台脚本中维护另一套不可追溯 SVG 几何。
3. 平台派生可以调整尺寸、编码格式和平台容器，但不得改变核心几何与品牌色。
4. 后续正式换版必须先更新主母版，再同步 Web、桌面构建资产和兼容引用。
5. 历史候选、一次性导出稿和设计过程不进入公开代码仓库。
