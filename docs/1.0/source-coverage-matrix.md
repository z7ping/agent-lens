# Source Coverage Matrix

状态：`完整` = 已安全保存并映射稳定语义；`原始` = SourceRecord 完整保留、Canonical 为 unknown/raw；`部分` = 只映射了原生事实的一部分；`—` = 来源不存在对应能力。

| Source | 原生类型 / 字段 | SourceRecord | Canonical Observation | 任务复盘 | Live | Raw Inspector | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pi | session | 完整 | session.lifecycle | 是 | Snapshot | 待 #47 | 会话 ID/cwd/version/父会话 |
| Pi | message/user | 完整 | message.user | 是 | Snapshot | 待 #47 | parentId 待 #44 贯通 |
| Pi | message/assistant | 完整 | message.assistant + reasoning + tool.call | 部分 | Snapshot | 待 #47 | usage/stopReason/error 待 #45 |
| Pi | message/toolResult | 完整 | tool.result | 是 | Snapshot | 待 #47 | 扩展结果字段待 #45 |
| Pi | model_change / thinking_level_change | 完整 | model.changed / thinking.level.changed | 是 | Snapshot | 待 #47 |  |
| Pi | compaction / branch_summary | 完整 | context.compaction / context.summary | 部分 | Snapshot | 待 #47 | 完整字段/树关系待 #44/#45 |
| Pi | session_info | 完整 | session.lifecycle | 是 | Snapshot | 待 #47 |  |
| Pi | custom/custom_message/label/extension/其他新增类型 | 完整 | unknown/raw | 待 #47 | Snapshot 原始 | 待 #47 | 不因未知而丢弃 |
| Codex | session_meta | 完整 | session.lifecycle | 部分 | — | 待 #47 | parent/thread/agent/provider 等待 #46 |
| Codex | metadata/session_start、session_title | 完整 | session.lifecycle | 是 | — | 待 #47 | AgentLens 稳定元数据记录 |
| Codex | response_item/message | 完整 | message.user/assistant 或 unknown | 是 | — | 待 #47 | injected context 仅语义层过滤，不裁 SourceRecord |
| Codex | response_item/function_call/output | 完整 | tool.call/result | 是 | — | 待 #47 |  |
| Codex | response_item/custom_tool_call/output | 完整 | tool.call/result | 是 | — | 待 #47 |  |
| Codex | response_item/web_search_call / reasoning | 完整 | tool.call / message.reasoning | 部分 | — | 待 #47 | 完整 action/status 待 #46 |
| Codex | event_msg/* / turn_context | 完整 | unknown/raw | 待 #47 | — | 待 #47 | usage/task/context 待 #46 |
| Codex | 新增/未知 rollout 类型 | 完整 | unknown/raw | 待 #47 | — | 待 #47 | 不因未知而丢弃 |

维护规则：每次新增 Source、升级 Parser 或补一种宿主原生类型时，同步更新本表，并明确“保存、标准化、复盘、Live、Inspector”五个层面的覆盖状态。
