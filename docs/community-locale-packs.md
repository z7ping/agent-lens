# AgentLens 社区 Locale Pack

AgentLens 官方只维护简体中文（`zh-CN`）。其他语言通过社区 Locale Pack 扩展。

Locale Pack 是**纯 JSON 数据文件**，不会作为 JavaScript、Node.js 或 Cordis 插件执行。

## 安装位置

将 `.json` 文件放入当前 AgentLens 数据目录下的：

```text
locales/
```

默认桌面/本地运行时对应 `~/.agent-lens/1.0/locales/`。重启或刷新 Web 后，AgentLens 会通过只读 HTTP 接口发现并注册合法语言包。

## 最小格式

```json
{
  "localeApiVersion": 1,
  "locale": "xx-YY",
  "name": "Community Locale",
  "compatibility": {
    "agentLensMajor": 1
  },
  "messages": {
    "common": {
      "loadingWorkspace": "..."
    },
    "navigation": {
      "task": "..."
    }
  }
}
```

规则：

- `locale` 必须是有效 BCP 47 语言标签；
- `messages` 只能包含对象与字符串，不能包含数组或可执行内容；
- 社区包不能覆盖官方 `zh-CN`；
- 同一个 locale 只能安装一个语言包；
- 单文件最大 1 MiB；
- 未提供的 key 自动回退到官方简体中文；
- Agent 名称、模型名、工具名、路径、SourceRecord、Evidence 和 native type 等原始事实不会被翻译。

## Namespace

当前稳定 namespace：

- `common`
- `navigation`
- `shell`
- `settings`
- `errors`

后续页面迁移时会继续增加产品域 namespace。社区语言包不必一次覆盖全部 key。
