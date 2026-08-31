const fs = require('node:fs')
const path = 'scripts/check-pi-live-contract.mjs'
let source = fs.readFileSync(path, 'utf8')

function insertAfter(pattern, addition, label) {
  const match = source.match(pattern)
  if (!match) throw new Error(`missing ${label}`)
  source = source.replace(pattern, `${match[0]}\n${addition}`)
}

insertAfter(
  /requireText\(page, \/projectPiLiveTaskRounds\\\(history\\\)\/, 'Pi Live 历史事实必须先投影为共享 TaskRoundModel'\)/,
  "requireText(page, /projectPiLiveTaskDetail\\(\\{[\\s\\S]{0,360}historyRounds,[\\s\\S]{0,220}runningRound/, 'Pi Live 必须把 Runtime 状态与 Round 收敛为统一 TaskDetailModel')\nrequireText(page, /agent=\\{taskDetailModel\\.agentLabel\\}/, 'Pi Live TaskHeader 的 Agent 必须来自 TaskDetailModel')\nrequireText(page, /context=\\{taskDetailModel\\.contextLabel\\}/, 'Pi Live TaskHeader 上下文必须来自 TaskDetailModel')\nrequireText(page, /title=\\{taskDetailModel\\.title\\}/, 'Pi Live TaskHeader 标题必须来自 TaskDetailModel')\nrequireText(page, /metrics=\\{taskDetailModel\\.metrics\\}/, 'Pi Live TaskHeader 指标必须来自 TaskDetailModel')\nrequireText(page, /runningRound && <PiLiveRunningTaskRound[\\s\\S]{0,320}model=\\{runningRound\\}/, 'Pi Live Running UI 与 TaskDetailModel 必须复用同一 TaskRoundModel')\nrequireText(piTaskProjection, /export function projectPiLiveRunningRound/, 'Pi Live 缺少 Running -> TaskRoundModel 投影')\nrequireText(piTaskProjection, /export function projectPiLiveTaskDetail/, 'Pi Live 缺少 Runtime -> TaskDetailModel 投影')\nrequireText(piTaskProjection, /contextLabel: runtimeModelLabel\\(state\\)/, 'Pi Live TaskDetailModel 必须投影 Runtime 模型上下文')",
  'Pi history projection contract',
)
insertAfter(
  /requireText\(taskDetailModel, \/export interface TaskDetailModel\//,
  "requireText(taskDetailModel, /contextLabel\\?: string/, 'TaskDetailModel 必须提供来源无关的二级上下文字段')",
  'TaskDetailModel contract',
)

fs.writeFileSync(path, source.replace(/[ \t]+$/gm, ''))
