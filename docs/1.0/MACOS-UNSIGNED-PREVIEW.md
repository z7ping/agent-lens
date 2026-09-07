# macOS 未签名预发布版安装与发行边界

状态：1.0 Alpha / Beta / RC 无 Developer ID 凭据时的正式约束

## 1. 结论

AgentLens 在没有 Apple Developer Program / Developer ID Application 证书时，仍可以构建和分发 macOS Desktop 预发布包，但不能把该包描述成“受 macOS 信任、下载后可无提示直接双击运行”的正式签名应用。

这是发行信任边界，不是应用代码能够绕过的限制。

当前策略：

- Alpha / Beta / RC：允许提供**明确标注为未签名、未公证**的 Desktop 预览包；
- Stable：必须使用 Developer ID Application 签名、Hardened Runtime 和 Apple Notarization；
- 没有签名/公证凭据时，Stable 不允许静默降级成未签名产物；
- macOS 用户在未签名阶段优先推荐 npm / CLI 作为低摩擦使用方式。

## 2. 未签名构建必须保持自洽

无签名 Desktop 构建必须同时满足：

```text
identity = null
hardenedRuntime = false
notarization = disabled
```

不能出现“没有代码签名，但仍强制 Hardened Runtime”的半签名状态。

有 Developer ID 凭据的正式 macOS 构建则使用：

```text
Developer ID Application signing
Hardened Runtime
Apple Notarization
```

两种构建模式必须通过独立入口表达，不能依靠环境偶然决定。

## 3. 用户首次打开未签名预览包

推荐流程：

1. 将 `AgentLens.app` 拖入 `/Applications`；
2. 尝试打开一次，让 macOS 记录阻止原因；
3. 打开 **系统设置 → 隐私与安全性**；
4. 在 AgentLens 对应提示处选择 **仍要打开 / Open Anyway**；
5. 再次确认打开。

完成一次明确授权后，后续通常不需要重复操作。

如果测试机仍因下载隔离属性阻止启动，狗粮阶段可以使用：

```bash
xattr -dr com.apple.quarantine /Applications/AgentLens.app
```

这条命令只作为**测试/狗粮兜底**，不是正常产品安装流程，也不代表应用获得了 Developer ID 信任。

## 4. 禁止的“解决方案”

不得为了消除 Gatekeeper 提示而：

- 自动替用户删除 quarantine 属性；
- 指导用户全局关闭 Gatekeeper；
- 使用 ad-hoc 签名冒充 Developer ID 签名；
- 把“已损坏”提示简单解释为安装包二进制损坏，除非哈希或文件检查确实证明产物损坏；
- 在 Release 页面把未签名包描述成与签名、公证包等价。

## 5. 未签名 Alpha 的验收口径

没有 Developer ID 凭据时，macOS Desktop 的验收目标是：

- DMG / ZIP 能正常解包，应用结构完整；
- 用户明确授权后应用能够启动；
- Desktop Runtime 能启动并报告兼容的 AgentLens Protocol；
- npm / launchd 模式下 `service start/status/restart/stop` 状态真实；
- Pi Live 能在后台环境中正确发现已安装的 Pi；
- 未签名包不会因为错误的 Hardened Runtime 配置造成额外启动失败；
- 文档明确提示该包未签名、未公证。

**“首次打开完全没有 macOS 安全提示”不属于无证书预发布阶段可实现的验收项。**

## 6. 获得 Developer ID 后

一旦项目具备 Apple Developer Program 和 Developer ID Application 证书，应把公开 macOS 分发切换为签名 + 公证模式，并重新评估是否还有继续公开未签名 Desktop 产物的必要。

签名解决的是发布者身份和平台信任；它不能替代 AgentLens 自己的 Runtime、生命周期、数据和升级验收。
