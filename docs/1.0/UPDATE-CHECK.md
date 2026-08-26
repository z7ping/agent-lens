# AgentLens 1.0 版本检测与更新

更新日期：2026-08-26  
状态：Alpha 发布前轻量更新能力

## 1. 当前范围

1.0 Alpha 提供两条发行更新路径：

- Windows Desktop：检测新版本 + 原生提示 + 前往下载安装包，不在客户端内静默替换；
- npm / CLI：检测新版本 + 命令行提示 + `agent-lens update --check` + `agent-lens update`。

两条路径都不把版本信息写入 Canonical Observation、Projection 或 SQLite。

## 2. Windows Desktop

```text
AgentLens Desktop
    ↓
读取 app.getVersion()
    ↓
最多每 24 小时查询一次 GitHub Releases
    ↓
没有新版 → 静默
检查失败 → 静默，不影响离线使用
发现新版 → Windows 通知 / 原生提示
    ↓
用户点击
    ↓
打开对应 Setup-x64.exe；若没有安装器资产，则打开 Release 页面
    ↓
用户运行安装器完成现有覆盖升级链
```

版本检测只读取公开的 `z7ping/agent-lens` GitHub Release 元数据，不上传 AgentLens 会话、观测、资产、路径或其他本地数据。

Desktop 检查状态保存在 Electron `userData/update-check.json`。

## 3. npm / CLI

正式 npm 包的 `agent-lens` bin 使用轻量入口层承接更新能力，再调用现有 1.0 CLI Core；不会复制或重写 service、Hook、Doctor 等既有生命周期逻辑。

### 3.1 显式检查

```bash
agent-lens update --check
```

有新版时输出当前版本、最新版本以及更新命令；没有新版时明确报告当前通道已是最新版本。

机器消费可使用：

```bash
agent-lens update --check --json
```

### 3.2 执行更新

```bash
agent-lens update
```

更新目标固定为检查阶段选出的精确版本，例如：

```bash
npm install --global @z7ping/agent-lens@1.0.0-alpha.1
```

不直接依赖 `latest` / `alpha` 等 dist-tag 完成最终版本选择，避免预发布通道误跳。

更新前会读取现有 npm service 状态：

- 当前运行时由 npm `service` 持有且正在运行：先停止 service，npm 全局升级完成后再恢复；
- 当前运行时由 Windows Desktop 持有：只更新 npm 包，不停止、不接管 Desktop Daemon；
- npm service 未运行：只升级包，不擅自启动后台服务；
- service 停止失败：取消升级，避免运行时与安装文件状态不一致；
- npm 升级失败：若此前主动停止了 npm service，会尽力恢复；
- 包升级成功但 service 恢复失败：明确提示用户执行 `agent-lens service start`。

### 3.3 被动提示

普通交互命令成功结束后，可最多每 24 小时检查一次 npm Registry。发现新版时只输出轻量提示：

```text
[更新] AgentLens 1.0.0-alpha.0 → 1.0.0-alpha.1
       执行：agent-lens update
```

规则：

- 提示写到 stderr，避免污染正常 stdout；
- `--json` 不追加提示；
- `--version` / `--help` 不请求网络；
- `start` / `service run` 等长运行命令不追加被动检查；
- 非交互终端、CI 环境默认不检查；
- 网络失败静默降级，不影响原 CLI 命令；
- 可通过 `AGENT_LENS_DISABLE_UPDATE_CHECK=1` 禁止被动检查；
- 状态保存在 `~/.agent-lens/1.0/runtime/npm-update-check.json`，仅属于本地运行/发行元数据，不属于 Canonical 数据。

## 4. 版本通道规则

当前不增加用户可配置的更新通道，直接依据“当前安装版本是否为预发布版”决定：

- 当前为正式版，例如 `1.0.0`：只接收更高的正式版，忽略 Alpha / Beta / RC；
- 当前为预发布版，例如 `1.0.0-alpha.0`：允许升级到更高的 Alpha / Beta / RC，也允许进入正式版；
- npm Registry 中已废弃（deprecated）的版本、无法解析为语义化版本的版本、低于或等于当前版本的版本一律忽略；
- GitHub Desktop 路径继续忽略 Draft Release 和无效 Tag。

语义化版本顺序遵循 SemVer，例如：

```text
1.0.0-alpha.0
< 1.0.0-alpha.1
< 1.0.0-beta.0
< 1.0.0-rc.1
< 1.0.0
< 1.0.1
```

## 5. Web 发行信息入口

1.0 Web 顶部保持轻量发行信息结构：

```text
AgentLens · v<当前版本>
                    运行状态 · GitHub · 更新日志 · 主题
```

规则：

- 当前版本读取正式 Web workspace 的 `package.json`；
- GitHub 固定指向 `z7ping/agent-lens` 仓库；
- “更新日志”使用轻量弹层，不增加一级导航页面；
- 当前版本摘要在 Web 构建时读取仓库根 `CHANGELOG.md` 当前版本章节；
- Desktop 中 GitHub / Release 外链交给系统默认浏览器；
- 发行静态元数据不进入 Canonical / Projection / SQLite。

## 6. 自动化门禁

Desktop 更新检查测试覆盖 GitHub Release、SemVer、预发布与正式版边界、Windows Setup 资产选择和 24 小时门限。

CLI 更新测试覆盖：

- Alpha / Beta / RC / Stable 的 SemVer 顺序；
- 正式版不接收预发布版；
- 预发布版可进入后续预发布或正式版；
- npm deprecated / 无效 / 旧版本过滤；
- 24 小时被动检查门限；
- npm 升级固定到选中的精确版本；
- JSON / 长运行命令不追加被动更新提示。

发行 smoke 还会验证正式 `dist/bin/agent-lens.mjs` 能输出版本，并在 `--help` 中暴露 `agent-lens update --check` / `agent-lens update`。

## 7. 暂不做的能力

Alpha 阶段暂不引入：

- Desktop `electron-updater` 自动下载安装；
- 静默 npm 自动升级；
- 强制更新；
- 用户手工选择 Stable / Beta / Alpha 更新通道；
- 后台无感替换正在运行的 npm Runtime。

这些能力等 Alpha 覆盖升级和实机狗粮稳定后，再决定是否在 Beta / RC 阶段加入。
