# AgentLens 1.0 桌面发行矩阵

更新日期：2026-08-26  
状态：Alpha 跨平台桌面发行基线

## 1. 发行范围

AgentLens Desktop 与 npm 共用同一个 1.0 Runtime、默认数据目录和 Canonical 数据模型。桌面包只负责系统壳与发行体验，不创建第二套 Daemon 或数据库。

当前正式构建矩阵：

| 平台 | 架构 | Release 产物 | 推荐安装/运行产物 |
| --- | --- | --- | --- |
| Windows | x64 | `AgentLens-<version>-Setup-x64.exe` | NSIS Setup |
| macOS | arm64 | `AgentLens-<version>-macOS-arm64.dmg`、`.zip` | DMG |
| macOS | x64 | `AgentLens-<version>-macOS-x64.dmg`、`.zip` | DMG |
| Linux | x64 | `AgentLens-<version>-Linux-x64.AppImage`、`.deb` | AppImage / DEB |
| npm | Node.js 22.23+ 支持的平台 | `z7ping-agent-lens-<version>.tgz` | npm 全局安装 |

macOS 同时覆盖 Apple Silicon 和 Intel。Linux Alpha 先保证 x64，不在当前阶段扩 arm64。

## 2. 构建入口

仓库根目录提供：

```bash
npm run desktop:win
npm run desktop:mac
npm run desktop:linux
```

三条链都先执行 Web/品牌/桌面壳检查，构建同一份正式 `dist/`，再复制到 Desktop `runtime/` 后交给 electron-builder 打包。

Windows 保留专用的 Electron 预解压方案，用于规避部分 Windows 安全软件对 electron-builder 临时可执行文件改名的干扰；macOS/Linux 使用 electron-builder 正常的当前平台 Electron 分发，不复用 Windows `electronDist`。

## 3. 品牌资产

唯一矢量主母版仍是：

```text
docs/design/brand/agentlens-icon-master.svg
```

`apps/desktop/build/icon.svg` 必须与主母版逐字一致。

- Windows：继续由 `scripts/prepare-windows-icon.ps1` 生成 ICO / PNG；
- macOS：`scripts/prepare-macos-icon.sh` 从同一 SVG 生成完整 16–1024px IconSet，再使用 `iconutil` 生成 ICNS；
- Linux：electron-builder 直接使用同一 SVG 派生资产。

品牌检查会阻止 Desktop SVG 与主母版漂移。

## 4. GitHub Actions 与 Release

`.github/workflows/desktop-macos-linux.yml` 在以下场景构建 macOS/Linux：

- `main` 上桌面发行相关文件变化；
- 手动运行；
- GitHub Release 发布。

Release 发布时，各平台产物自动附加到同一个 Release Assets。

校验文件按发行面拆分，避免多个工作流使用同名 `SHA256SUMS.txt` 相互覆盖：

```text
SHA256SUMS-windows.txt
SHA256SUMS-macos-arm64.txt
SHA256SUMS-macos-x64.txt
SHA256SUMS-linux-x64.txt
SHA256SUMS-npm.txt
```

## 5. 桌面运行时冒烟

macOS/Linux 不只检查“文件是否生成”。工作流会从 unpacked App 中找到实际 Electron 可执行文件，并通过：

```text
ELECTRON_RUN_AS_NODE=1
→ packaged runtime/daemon.mjs
→ 随机本地端口
→ /api/v1/health
```

验证：

- 打包后的 Electron 能加载随包 Runtime；
- `better-sqlite3` 等原生依赖与目标平台匹配；
- Protocol Version = `1.0`；
- Runtime Owner = `desktop`。

Windows 继续使用已有的 GUI/Health/安装覆盖升级冒烟。

## 6. npm / Desktop 共存

macOS/Linux Desktop 与 Windows Desktop 使用同一个安装登记模型：

- Desktop 启动时登记自身 executable / hookRoot / version；
- npm 和 Desktop 可以同时存在；
- 默认端口已有兼容 Daemon 时直接复用；
- Desktop 只停止自己拥有的 Daemon；
- `~/.agent-lens/1.0` 继续作为共享默认数据根。

Windows Hook 仍使用共享 PowerShell 分发器；macOS/Linux Desktop 的 Hook 命令直接通过当前 Desktop Electron 的 Node 模式调用随包 Hook，不依赖用户额外全局安装 npm CLI。

## 7. Alpha 签名边界

当前 Alpha 允许未签名构建：

- Windows 未配置证书时可能出现“未知发布者”/SmartScreen；
- macOS 未配置 Apple Developer ID 与公证时可能触发 Gatekeeper 提示；
- Linux AppImage / DEB 当前不额外做发行签名。

这不影响构建与功能验证，但在 Beta/RC 面向更广泛用户前应把 macOS 签名/公证和正式发行签名策略单独收口。
