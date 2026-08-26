# AgentLens 1.0 版本检测与更新

更新日期：2026-08-26  
状态：Alpha 发布前轻量更新能力

## 1. 当前范围

1.0 Alpha 提供两条发行更新路径：

- Desktop（Windows / macOS / Linux）：检测新版本 + 原生提示 + 前往对应平台下载，不在客户端内静默替换；
- npm / CLI：检测新版本 + 命令行提示 + `agent-lens update --check` + `agent-lens update`。

两条路径都不把版本信息写入 Canonical Observation、Projection 或 SQLite。

## 2. Desktop

```text
AgentLens Desktop
    ↓
读取 app.getVersion() + process.platform/process.arch
    ↓
最多每 24 小时查询一次 GitHub Releases
    ↓
没有新版 → 静默
检查失败 → 静默，不影响离线使用
发现新版 → 系统通知 / 原生提示
    ↓
用户点击
    ↓
优先打开当前平台与架构的 Release 资产
没有匹配资产 → 打开 Release 页面
```

平台资产选择：

| 平台 | 架构 | 优先级 |
| --- | --- | --- |
| Windows | x64 | `Setup-x64.exe` |
| macOS | arm64 / x64 | `.dmg` > `.zip` |
| Linux | x64 | `.AppImage` > `.deb` |

版本检测只读取公开的 `z7ping/agent-lens` GitHub Release 元数据，不上传 AgentLens 会话、观测、资产、路径或其他本地数据。

Desktop 检查状态保存在 Electron `userData/update-check.json`。

当前不会自动下载安装；用户下载后按目标平台的正常安装/覆盖方式升级，`~/.agent-lens/1.0` 仍作为共享用户数据目录。

## 3. npm / CLI

正式 npm 包的 `agent-lens` bin 使用轻量入口层承接更新能力，再调用现有 1.0 CLI Core；不会复制或重写 service、Hook、Doctor 等既有生命周期逻辑。

### 3.1 显式检查

```bash
agent-lens update --check
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
- 当前运行时由 Desktop 持有：只更新 npm 包，不停止、不接管 Desktop Daemon；
- npm service 未运行：只升级包，不擅自启动后台服务；
- service 停止失败：取消升级；
- npm 升级失败：若此前主动停止了 npm service，会尽力恢复；
- 包升级成功但 service 恢复失败：明确提示用户执行 `agent-lens service start`。

### 3.3 被动提示

普通交互命令成功结束后，最多每 24 小时检查一次 npm Registry。发现新版时只输出轻量提示：

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
- 网络失败静默降级；
- 可通过 `AGENT_LENS_DISABLE_UPDATE_CHECK=1` 禁止被动检查；
- 状态保存在 `~/.agent-lens/1.0/runtime/npm-update-check.json`。

## 4. 版本通道规则

当前不增加用户可配置的更新通道，直接依据当前安装版本决定：

- 正式版只接收更高正式版；
- 预发布版允许升级到更高 Alpha / Beta / RC，也允许进入正式版；
- npm deprecated / 无效 / 旧版本忽略；
- GitHub Desktop 路径忽略 Draft Release 和无效 Tag。

```text
1.0.0-alpha.0
< 1.0.0-alpha.1
< 1.0.0-beta.0
< 1.0.0-rc.1
< 1.0.0
< 1.0.1
```

## 5. Web 发行信息入口

1.0 Web 顶部保持：

```text
AgentLens · v<当前版本>
                    运行状态 · GitHub · 更新日志 · 主题
```

版本和更新日志属于发行静态元数据，不进入 Canonical / Projection / SQLite。

## 6. 自动化门禁

Desktop 更新检查测试覆盖：

- GitHub Release / SemVer；
- 预发布与正式版边界；
- Windows / macOS / Linux 平台与架构资产选择；
- 平台资产缺失时回退 Release 页面；
- 24 小时门限。

CLI 更新测试继续覆盖 npm 版本选择、精确升级目标和 JSON / 长运行命令边界。

桌面发行的构建与运行时冒烟见 `docs/1.0/DESKTOP-RELEASES.md`。

## 7. 暂不做

Alpha 阶段暂不引入：

- Desktop `electron-updater` 自动下载安装；
- 静默 npm 自动升级；
- 强制更新；
- 用户手工选择 Stable / Beta / Alpha 更新通道；
- 后台无感替换正在运行的 npm Runtime。

这些能力等 Alpha 覆盖升级和实机狗粮稳定后，再决定是否在 Beta / RC 阶段加入。
