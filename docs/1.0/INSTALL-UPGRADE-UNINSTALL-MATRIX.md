# AgentLens 1.0 安装 / 升级 / 卸载回归矩阵

更新日期：2026-08-24  
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
9. 卸载发行文件默认不删除数据库、Inbox、Vault 等共享用户数据；
10. 不恢复 PID 文件、旧 Service Manager、Hook Runner 或第二套 Runtime。

## 2. 自动回归矩阵

| 场景 | 单元测试 | CI 集成 | 预期 |
| --- | --- | --- | --- |
| npm 首次登记 | 是 | 间接 | 真实文件存在时登记有效 |
| npm 升级重新登记 | 是 | — | 新版本 / 路径生效，首次登记时间保留 |
| npm 与 Desktop 共存 | 是 | Windows | 两份登记互不覆盖，共享分发器可选择有效 Provider |
| 卸载 npm、Desktop 保留 | 是 | Windows | npm 登记失效；共享分发器继续使用 Desktop |
| 卸载 Desktop、npm 保留 | 是 | Windows | Desktop 登记失效；共享分发器回退 npm |
| 两边都卸载 | 是 | Windows | 两份陈旧登记均不算安装事实；共享分发器中性退出 |
| 卸载后共享数据 | 是 | — | `~/.agent-lens/1.0` 数据不因 Provider 文件消失被删除 |
| Windows npm 后台服务 | 结构测试 | Windows | Task Scheduler 注册、隐藏窗口、`owner=service`、doctor 一致 |
| Windows 登录自启 | 结构测试 | Windows | 登录触发与后台任务状态一致 |
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

## 4. 升级语义

升级不是创建新的生命周期体系，只是让当前发行重新登记自身真实位置：

```text
旧 Provider 登记
    ↓
新版本启动 / setup / hook status
    ↓
原子覆盖同 kind 登记
    ├─ registeredAt 保留
    ├─ updatedAt 更新
    ├─ version 更新
    ├─ executable 更新
    └─ hookRoot 更新
```

旧安装目录随后被包管理器删除，不应使新登记失效，也不需要迁移共享数据库。

## 5. 卸载语义

AgentLens 不依赖“卸载回调一定执行”。特别是 npm 发行不能把正确性建立在 package uninstall lifecycle 上。

因此：

```text
发行文件存在   → 登记可验证 → Provider 有效
发行文件消失   → 登记验证失败 → Provider 无效
登记 JSON 残留 → 允许
共享用户数据残留 → 默认允许且必须保留
```

只有未来明确提供“清除所有本机数据”的独立危险操作时，才允许删除 `~/.agent-lens/1.0`；普通卸载不做这件事。

## 6. 仍需实机验收

以下项目不能因为 CI 通过就标记完成：

- Windows 从真实 npm 全局包首次安装 → setup → service start；
- Windows npm 从旧构建升级到新构建后，服务和 Hook 指向新 Provider；
- Windows 真实 Desktop 安装包覆盖升级；
- npm + Desktop 同装时只有一个 Daemon；
- 两边都设置登录自启时仍只有一个 Daemon；
- 卸载 npm 后真实 Desktop Hook 继续工作；
- 卸载 Desktop 后真实 npm Hook 继续工作；
- 两边都卸载后 Codex / Claude Code 不被残留 Hook 阻断；
- Windows 全流程肉眼无黑色控制台闪现；
- Linux 常见发行版 / WSL 的 `systemd --user` 安装、升级、停止与卸载；
- macOS LaunchAgent 安装、升级、登录加载与卸载。

## 7. P0-3 完成标准

P0-3 的代码收口完成，要求：

- 安装登记、升级替换、轮流卸载、数据保留有自动测试；
- Windows 共享分发器双向回退和全失效中性退出进入 CI；
- 已有 Windows npm lifecycle 验证继续保留；
- 三平台发行构建 / 冒烟 / npm 包内容检查继续保留；
- 实机项明确保持“待验收”，不得用自动测试替代。

P0-3 不包含 npm 发布、GitHub Release，也不要求为测试回归旧生命周期实现。
