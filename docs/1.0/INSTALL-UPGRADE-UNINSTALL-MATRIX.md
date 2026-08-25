# AgentLens 1.0 安装 / 升级 / 卸载回归矩阵

更新日期：2026-08-26  
状态：P0-3 稳定化基线

本文把 npm / CLI 与 Windows Desktop 的安装、升级、卸载和共存规则转换为可重复验收项。架构边界仍以 `DISTRIBUTION-OPERATIONS.md` 与 ADR-0004 为准；本矩阵不引入新的生命周期实现。

## 1. 验收不变量

所有场景都必须守住：

1. npm / Desktop 共用 `~/.agent-lens/1.0`；
2. 默认端口只有一个兼容 Daemon；
3. 安装登记只是候选 Provider，不是安装事实；
4. Provider 的真实文件消失后立即视为无效，即使登记 JSON 仍残留；
5. 升级重新登记新 executable / hookRoot / version，同时保留首次 `registeredAt`；
6. Windows Hook 固定指向共享分发器，不绑定某个发行路径；
7. Desktop 有效时优先，Desktop 无效时回退 npm；
8. 两个 Provider 都无效时 Hook 中性退出，不能阻断上游 Agent；
9. Windows Desktop 新安装器必须能在已有安装存在时直接覆盖升级 / 重装，不要求用户先手工卸载；
10. Windows Desktop 覆盖升级始终保留 `~/.agent-lens/1.0`；
11. 用户主动卸载 Windows Desktop 时可以选择同时删除 `~/.agent-lens/1.0`，默认选择为“保留”；静默卸载也必须保留；
12. npm / Desktop 普通卸载默认不删除数据库、Inbox、Vault 等共享用户数据；
13. 不恢复 PID 文件、旧 Service Manager、Hook Runner 或第二套 Runtime；
14. Windows Desktop 的 Runtime、生产依赖和原生图标资源必须从 `app.asar.unpacked` 真实文件路径执行 / 读取；
15. “Windows 安装包生成成功”不等于“客户端可用”，打包后 EXE 必须真实启动并提供兼容 Health；
16. Windows Desktop 只要 Electron 主进程启动过，就必须默认写 `%APPDATA%\AgentLens\logs\desktop.log`；Daemon 输出继续写同日志目录下的 `daemon.log`。

## 2. 自动回归矩阵

| 场景 | 单元测试 | CI 集成 | 预期 |
| --- | --- | --- | --- |
| npm 首次登记 | 是 | 间接 | 真实文件存在时登记有效 |
| npm 升级重新登记 | 是 | — | 新版本 / 路径生效，首次登记时间保留 |
| npm 与 Desktop 共存 | 是 | Windows | 两份登记互不覆盖，共享分发器可选择有效 Provider |
| 卸载 npm、Desktop 保留 | 是 | Windows | npm 登记失效；共享分发器继续使用 Desktop |
| 卸载 Desktop、npm 保留 | 是 | Windows | Desktop 登记失效；共享分发器回退 npm |
| 两边都卸载 | 是 | Windows | 两份陈旧登记均不算安装事实；共享分发器中性退出 |
| 卸载后共享数据 | 是 | Windows Installer | `~/.agent-lens/1.0` 默认保留 |
| Windows npm 后台服务 | 结构测试 | Windows | Task Scheduler 注册、隐藏窗口、`owner=service`、doctor 一致 |
| Windows 登录自启 | 结构测试 | Windows | 登录触发与后台任务状态一致 |
| Windows 打包客户端启动 | — | Windows | `win-unpacked/AgentLens.exe` 无参数启动，Health 可用且 `owner=desktop` |
| Windows 安装器首次安装 | — | 安装器工作流 | 安装后真实 EXE 可启动，Health 可用 |
| Windows 安装器覆盖已有安装 | — | 安装器工作流 | 不手工卸载即可再次运行安装器并成功启动新版 / 重装后的 EXE |
| Windows 同版本覆盖重装 | — | 安装器工作流 | alpha 狗粮中版本号不变、构建变化时仍能覆盖已有安装 |
| Windows 升级数据保留 | — | 安装器工作流 | 覆盖安装前写入 `~/.agent-lens/1.0` 的标记在升级后仍存在 |
| Windows 静默卸载数据保留 | — | 安装器工作流 | `/S` 卸载默认保留 `~/.agent-lens/1.0` |
| Windows 主动卸载删除数据 | 实机 | — | 卸载器询问是否删除本地数据，默认“否”；用户明确选“是”才删除 |
| Windows 应用图标 | 构建生成 | Windows | 从正式 Logo 生成多尺寸应用图标并用于窗口 / EXE / 托盘 |
| Linux 后台服务定义 | 是 | 构建/测试 | 使用 `systemd --user`，不维护 PID |
| macOS 后台服务定义 | 是 | 构建/测试 | 使用用户 LaunchAgent，登录自启独立控制 |
| npm 正式发行内容 | — | 三平台 | `build:dist`、冒烟、`npm pack --dry-run` 通过 |

“—”不表示功能不存在，只表示该项不能由当前这一层自动化独立证明。

## 3. Windows 共享 Hook 分发器矩阵

CI 必须至少覆盖三条真实执行路径：

```text
Desktop 登记陈旧 + npm 有效
→ 跳过 Desktop
→ npm Hook
→ Durable Inbox

npm 登记陈旧 + Desktop 有效
→ Desktop Hook
→ Durable Inbox

Desktop / npm 都陈旧
→ 不启动 Provider
→ 中性退出 0
→ 不产生 Inbox 事件
```

这三条都不允许改写原生 Codex / Claude Code Hook 配置。共享分发器每次调用都重新验证 `executable + hookRoot + 目标 Hook 文件`。

## 4. Windows Desktop 打包、升级与启动门禁

Windows Desktop 需要额外验证“打包产物真的能运行”，不能只检查 Electron Builder 是否退出 0：

```text
build:dist
    ↓
desktop:prepare
    ↓
electron-builder --win dir
    ↓
无参数启动 win-unpacked/AgentLens.exe
    ↓
等待 /api/v1/health
    ├─ protocolVersion = 1.0
    └─ runtime.owner = desktop
```

Windows Installer 工作流还必须覆盖真实升级语义：

```text
第一次安装到临时目录
    ↓
启动并通过 Health
    ↓
在 ~/.agent-lens/1.0 写入测试数据
    ↓
不卸载，直接再次运行同一安装器
    ↓
覆盖安装成功 + EXE 仍可启动
    ↓
测试数据仍存在
    ↓
静默卸载
    ↓
测试数据仍存在
```

这里故意允许“同一个版本号重复安装”，因为 1.0 alpha 狗粮期间经常出现版本号未变、构建内容已更新的情况。CI 必须证明用户不需要先手工卸载旧客户端。

桌面 Runtime、CLI、Hook、Web、迁移资源和生产依赖在打包后都必须位于真实可执行文件路径范围内。Windows 原生应用图标也使用构建时从正式 Logo 派生的多尺寸资源。

自动门禁证明的是“产物能安装 / 覆盖 / 启动并默认保留数据”。桌面快捷方式、任务栏 / 托盘肉眼图标、窗口交互、卸载器交互选择和高 DPI 视觉表现仍属于实机验收。

## 5. Windows 升级语义

Windows Desktop 使用稳定 `appId = dev.z7ping.agentlens` 作为安装身份基线。该 `appId` 不允许在 1.x 中随意变化，因为 electron-builder 会据此生成稳定的安装 GUID；改变安装身份会破坏旧安装识别。

辅助安装器检测到已有安装时，目标行为是：

```text
已有 AgentLens
    ↓
运行新版安装器
    ↓
识别原安装范围和安装目录
    ↓
自动进入升级 / 重装
    ↓
清理旧程序文件并安装新程序
    ↓
保留 ~/.agent-lens/1.0
    ↓
重新启动 / 复用单一 Daemon
```

用户不应被要求先进入 Windows“已安装的应用”手工卸载旧版本。

## 6. 卸载语义

AgentLens 仍不依赖“卸载回调一定执行”来保证 Provider 正确性。发行文件消失后，登记验证失败即可视为 Provider 无效。

Windows Desktop 的交互卸载增加一层用户选择：

```text
卸载 AgentLens 程序
    ↓
是否同时删除 AgentLens 本地数据？
    ├─ 否（默认）→ 保留 ~/.agent-lens/1.0
    └─ 是         → 删除 ~/.agent-lens/1.0
```

升级 / 重装过程中绝不弹出这个数据删除选择，也绝不删除共享数据。静默卸载使用默认“保留数据”语义。

因此普通场景仍保持：

```text
发行文件存在   → 登记可验证 → Provider 有效
发行文件消失   → 登记验证失败 → Provider 无效
登记 JSON 残留 → 允许
共享用户数据残留 → 默认允许且必须保留
```

## 7. Windows 日志与启动故障诊断

桌面端日志目录：

```text
%APPDATA%\AgentLens\logs\
├── desktop.log   # Electron 主进程启动、未处理异常、Renderer/GPU 子进程退出
└── daemon.log    # Daemon stdout/stderr、启动/复用/恢复记录
```

`desktop.log` 不依赖 Daemon、窗口或托盘成功创建。只要 Electron bootstrap 被执行，就应留下启动阶段记录，用于定位“安装后双击完全没有反应”的早期崩溃。

## 8. 仍需实机验收

以下项目不能因为 CI 通过就标记完成：

- Windows 从真实 npm 全局包首次安装 → setup → service start；
- Windows npm 从旧构建升级到新构建后，服务和 Hook 指向新 Provider；
- Windows 真实 Desktop 安装包覆盖升级，确认无需手动卸载；
- Windows 交互卸载时“删除本地数据”默认不选，选择“是”后真实删除数据；
- Windows 安装后双击无响应时 `desktop.log` 能提供可定位信息；
- Windows 桌面快捷方式、任务栏、窗口图标和托盘图标在普通 DPI / 高 DPI、明暗桌面下肉眼可辨；
- Windows 用户双击安装后的桌面快捷方式时窗口有即时启动反馈；
- npm + Desktop 同装时只有一个 Daemon；
- 两边都设置登录自启时仍只有一个 Daemon；
- 卸载 npm 后真实 Desktop Hook 继续工作；
- 卸载 Desktop 后真实 npm Hook 继续工作；
- 两边都卸载后 Codex / Claude Code 不被残留 Hook 阻断；
- Windows 全流程肉眼无黑色控制台闪现；
- Linux 常见发行版 / WSL 的 `systemd --user` 安装、升级、停止与卸载；
- macOS LaunchAgent 安装、升级、登录加载与卸载。

## 9. P0-3 完成标准

P0-3 的代码收口完成，要求：

- 安装登记、升级替换、轮流卸载、数据保留有自动测试；
- Windows 共享分发器双向回退和全失效中性退出进入 CI；
- Windows 打包后的客户端真实启动进入主 CI；
- Windows 安装器首次安装、同版本覆盖安装、升级数据保留、静默卸载数据保留进入安装器工作流；
- Windows 交互卸载可选删除本地数据，并保持默认保留；
- Windows 桌面早期启动日志默认落盘；
- 已有 Windows npm lifecycle 验证继续保留；
- 三平台发行构建 / 冒烟 / npm 包内容检查继续保留；
- 实机项明确保持“待验收”，不得用自动测试替代。

P0-3 不包含 npm 发布、GitHub Release，也不要求为测试回归旧生命周期实现。
