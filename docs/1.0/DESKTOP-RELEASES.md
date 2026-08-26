# AgentLens 1.0 桌面发行矩阵

更新日期：2026-08-27  
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
| Linux | arm64 | `AgentLens-<version>-Linux-arm64.AppImage`、`.deb` | AppImage / DEB |
| npm | Node.js 22.23+ 支持的平台 | `z7ping-agent-lens-<version>.tgz` | npm 全局安装 |

macOS 同时覆盖 Apple Silicon 和 Intel；Linux x64 与 arm64 都使用对应架构的 GitHub Runner 原生安装依赖和打包，避免对 `better-sqlite3` 等原生模块做不可靠的伪交叉编译。

## 2. 构建入口

仓库根目录提供：

```bash
npm run desktop:win
npm run desktop:mac
npm run desktop:mac:release
npm run desktop:linux
```

普通 `desktop:mac` 用于无签名构建；`desktop:mac:release` 用于正式稳定版，强制代码签名和 Apple 公证。

各平台都先执行 Web / 品牌 / 桌面壳检查，构建同一份正式 `dist/`，再复制到 Desktop `runtime/` 后交给 electron-builder 打包。

Windows 保留专用的 Electron 预解压方案，用于规避部分 Windows 安全软件对 electron-builder 临时可执行文件改名的干扰；macOS/Linux 使用 electron-builder 正常的当前平台 Electron 分发，不复用 Windows `electronDist`。

## 3. 品牌资产

唯一矢量主母版仍是：

```text
docs/design/brand/agentlens-icon-master.svg
```

`apps/desktop/build/icon.svg` 必须与主母版逐字一致。

- Windows：继续由 `scripts/prepare-windows-icon.ps1` 生成 ICO / PNG；
- macOS：`scripts/prepare-macos-icon.sh` 从同一 SVG 生成完整 16–1024px IconSet，再使用 `iconutil` 生成 ICNS；
- Linux：electron-builder 直接使用同一 SVG 派生资产；
- macOS/Linux 运行时托盘不再引用 Windows `tray.ico`，而是从系统解析当前应用图标建立托盘图像。

品牌检查会阻止 Desktop SVG 与主母版漂移。

## 4. GitHub Actions 与 Release

`.github/workflows/desktop-macos-linux.yml` 在以下场景构建 macOS/Linux：

- `main` 上桌面发行相关文件变化；
- 手动运行；
- GitHub Release 发布。

当前签名策略按 GitHub Release 是否标记为 prerelease 区分：

- Alpha / Beta / RC 等预发布版允许 Windows/macOS 生成并公开上传未签名产物，用于狗粮和早期测试；
- Stable Release 继续强制 Windows 代码签名，以及 macOS Developer ID 签名 + Apple 公证；
- 未签名预发布包仍必须通过完整源码检查、打包 Runtime 冒烟、安装/升级验证和 SHA256 校验；
- 未签名 Windows/macOS 包可能触发 SmartScreen / Gatekeeper 警告，这属于预发布阶段已知限制。

Release 发布时，各平台产物自动附加到同一个 Release Assets。

校验文件按发行面拆分：

```text
SHA256SUMS-windows.txt
SHA256SUMS-macos-arm64.txt
SHA256SUMS-macos-x64.txt
SHA256SUMS-linux-x64.txt
SHA256SUMS-linux-arm64.txt
SHA256SUMS-npm.txt
```

## 5. Windows 代码签名

Stable Windows Release 工作流要求以下 GitHub Secrets：

```text
WINDOWS_CSC_LINK
WINDOWS_CSC_KEY_PASSWORD
```

`WINDOWS_CSC_LINK` 按 electron-builder 支持的证书输入方式提供 PFX / P12 证书，密码放在 `WINDOWS_CSC_KEY_PASSWORD`。

Stable Release 工作流会在构建前检查凭据，构建后使用 Windows Authenticode 再次验证：

- NSIS Setup 签名必须为 `Valid`；
- 安装后的 `AgentLens.exe` 签名也必须为 `Valid`；
- 任一不满足时停止 Stable Release 产物上传。

预发布 Release 不要求上述 Secrets，可以生成未签名 NSIS Setup；日常 `Windows Installer Compile` 仍是无凭据的可构建性验证，不承担“正式签名产物”语义。

## 6. macOS Developer ID 与公证

Stable macOS Release 使用：

- Developer ID Application 代码签名；
- Hardened Runtime；
- `apps/desktop/build/entitlements.mac.plist` 与继承权限；
- Apple Notarization；
- 构建后 `codesign`、`spctl`、`stapler` 三重验证。

签名 Secrets：

```text
MACOS_CSC_LINK
MACOS_CSC_KEY_PASSWORD
```

公证二选一。

Apple ID 方式：

```text
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
```

App Store Connect API Key 方式：

```text
APPLE_API_KEY_P8
APPLE_API_KEY_ID
APPLE_API_ISSUER
```

`APPLE_API_KEY_P8` 保存 `.p8` 文件正文；工作流只在 Runner 临时目录物化它，不写入仓库和构建产物。

预发布 Release 使用普通 `desktop:mac` 生成未签名、未公证的 DMG / ZIP；Stable Release 缺少 Developer ID 或公证凭据时仍直接失败，禁止 Stable 静默回退成未签名产物。

## 7. 桌面运行时冒烟

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

Windows 继续使用已有的 GUI / Health / 安装覆盖升级冒烟。

## 8. 登录后自动运行

Windows、macOS、Linux Desktop 统一暴露“登录系统后自动运行”，但各自使用平台原生机制：

- Windows：Electron 登录项，启动参数为 `--hidden`；
- macOS：系统登录项，并识别 `wasOpenedAtLogin` 以隐藏窗口启动；
- Linux：`$XDG_CONFIG_HOME/autostart/agentlens.desktop`，没有配置 XDG 时使用 `~/.config/autostart/agentlens.desktop`。

Linux AppImage 登记时优先使用环境变量 `APPIMAGE` 指向的稳定文件路径，而不是 AppImage 临时挂载目录中的 `process.execPath`。已有自启登记会在后续启动时刷新，便于覆盖升级后保持正确路径。

如果登录自启以隐藏方式启动，托盘仍是恢复窗口的正式入口；因此 macOS/Linux 托盘不能依赖 Windows 专用 ICO。

## 9. npm / Desktop 共存

各平台 Desktop 使用同一个安装登记模型：

- Desktop 启动时登记自身 executable / hookRoot / version；
- npm 和 Desktop 可以同时存在；
- 默认端口已有兼容 Daemon 时直接复用；
- Desktop 只停止自己拥有的 Daemon；
- Runtime Owner = `desktop` 在所有平台统一显示为“桌面端”；
- `~/.agent-lens/1.0` 继续作为共享默认数据根。

Windows Hook 仍使用共享 PowerShell 分发器；macOS/Linux Desktop 的 Hook 命令直接通过当前 Desktop Electron 的 Node 模式调用随包 Hook，不依赖用户额外全局安装 npm CLI。

## 10. Linux 发行签名边界

当前 AppImage / DEB 仍不额外增加 GPG / 仓库签名。Alpha 通过 GitHub Release HTTPS、每架构 SHA256 校验和与可重建 CI 产物建立完整性边界。

如果后续提供 APT 仓库，再单独引入仓库元数据签名；不为了当前独立 `.deb` 提前建立一套仓库密钥体系。
