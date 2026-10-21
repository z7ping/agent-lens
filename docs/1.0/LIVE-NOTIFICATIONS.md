# Live 站内通知（Issue #571）

## 入口与约束
- 任务列表标题栏：唯一铃铛，未读数、全部/未读、已读及点击返回原 Live Runtime。
- 任务正文：重要通知横幅；普通信息不弹。成功 5 秒消失，失败/提醒/审批直至关闭。
- 非任务页面仅在左侧「任务」一级导航显示未读提示；不再添加第二个铃铛。
- 复用 UiIcon、IconButton、Popover、Button 和正式语义字体/颜色。

## 数据路径
`Pi SDK extension.ui.notify` → `extension_ui_request(method=notify)` → Pi Adapter `LiveNotificationEvent` → 共享 Live SSE 聚合 → 浏览器通知中心。

Codex 已有的原生 `turn/completed`、`error` 与审批 `ui.request` 参与跨会话提醒；不根据输出文本、工具成功或文件变更猜测完成。Pi `setStatus` / `setWidget` 属于临时 UI 状态，不按通知事件持久化。

## 边界
- 会话事实仍归 Source / Native History；通知只保留最多 100 条轻量元数据及会话链接，不复制会话正文。
- 浏览器本地存储保留未读；刷新后保留通知记录。聚合 SSE 在线期间采集，会话更新以 native ID + session 去重。
- 浏览器关闭、服务关闭及 SSE 不可达期间不承诺补投通知；如果未来需要离线历史/多设备同步，必须经由可持久化的服务端事实/通知仓库扩展，不把 LocalStorage 伪装为服务端可靠队列。
