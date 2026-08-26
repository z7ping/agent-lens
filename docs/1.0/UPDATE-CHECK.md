# AgentLens 1.0 Windows 版本检测

更新日期：2026-08-26  
状态：Alpha 发布前轻量更新能力

## 1. 当前范围

1.0 Alpha 先提供“检测新版本 + 提示 + 前往下载”，不在客户端内自动下载、静默替换或自动重启安装。

适用范围：Windows Desktop。npm 用户继续通过 npm 自身完成版本查询和升级。

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
打开对应 Setup-x64.exe；若该 Release 没有安装器资产，则打开 Release 页面
    ↓
用户运行安装器完成现有覆盖升级链
```

版本检测只读取公开的 `z7ping/agent-lens` GitHub Release 元数据，不上传 AgentLens 会话、观测、资产、路径或其他本地数据。请求仅携带正常 HTTP 信息以及用于版本识别的 `User-Agent: AgentLens/<version>`。

## 2. 版本通道规则

当前不增加用户可配置的更新通道，直接依据“当前安装版本是否为预发布版”决定：

- 当前为正式版，例如 `1.0.0`：只接收更高的正式版，忽略 Alpha / Beta / RC；
- 当前为预发布版，例如 `1.0.0-alpha.0`：允许升级到更高的 Alpha / Beta / RC，也允许进入正式版；
- Draft Release、无法解析为语义化版本的 Tag、低于或等于当前版本的 Release 一律忽略。

语义化版本顺序遵循 SemVer，例如：

```text
1.0.0-alpha.0
< 1.0.0-alpha.1
< 1.0.0-beta.0
< 1.0.0-rc.1
< 1.0.0
< 1.0.1
```

## 3. 检查频率与降噪

Desktop 在正式打包环境下启动后执行检查，并在长时间常驻时每 24 小时再次检查。

检查状态保存在 Electron `userData/update-check.json`，至少记录：

- `lastCheckedAt`：最近一次成功取得 Release 列表的时间；
- `lastNotifiedVersion`：最近已经提示过的远端版本。

同一个远端版本默认只主动提示一次，避免每次启动反复打扰用户。网络失败、GitHub 不可达、返回异常、状态文件不可写都不得影响 AgentLens 启动、Daemon 生命周期、Hook 或本地数据访问。

## 4. 下载与升级边界

版本检测本身不执行安装器，也不修改 `~/.agent-lens/1.0`。

优先寻找 Release 中符合下面命名的 Windows 安装包：

```text
AgentLens-<version>-Setup-x64.exe
```

找到后直接打开该资产的浏览器下载地址；没有匹配资产时回退到 Release 页面。

真正的升级仍复用现有 Windows Installer 语义：稳定 `appId`、直接覆盖旧安装、保留 `~/.agent-lens/1.0`、启动后数据库 Migration 与 Desktop Provider 重新登记。

## 5. 自动化门禁

`apps/desktop/src/update-check.test.mjs` 至少覆盖：

- SemVer 与 Alpha / Beta / RC / Stable 顺序；
- 正式版不接收预发布版；
- 预发布版可进入后续预发布或正式版；
- Draft / 无效 Tag / 旧版本忽略；
- Windows Setup 资产优先；
- 24 小时检查门限；
- GitHub Release 列表请求与版本选择。

Desktop workspace 的 `npm test` 已纳入根级 `npm test --workspaces --if-present`，因此三平台主 CI 和 Windows Installer 工作流都会执行这组纯逻辑测试。

## 6. 暂不做的能力

Alpha 阶段暂不引入 `electron-updater`，也暂不做：

- 后台下载更新包；
- 下载进度 UI；
- 客户端内 SHA / 签名校验后的自动安装；
- “退出并安装”；
- Stable / Beta / Alpha 用户可选通道；
- 强制更新。

这些能力等 Alpha 覆盖升级和实机狗粮稳定后，再决定是否在 Beta / RC 阶段加入。
