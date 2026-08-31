const fs = require('node:fs')
const path = 'scripts/check-pi-live-contract.mjs'
let source = fs.readFileSync(path, 'utf8')

const malformed = `requireText(taskDetailModel, /export interface TaskDetailModel/
requireText(taskDetailModel, /contextLabel\\?: string/, 'TaskDetailModel 必须提供来源无关的二级上下文字段'), '统一 TaskDetailModel 缺失')`
const repaired = `requireText(taskDetailModel, /export interface TaskDetailModel/, '统一 TaskDetailModel 缺失')
requireText(taskDetailModel, /contextLabel\\?: string/, 'TaskDetailModel 必须提供来源无关的二级上下文字段')`
if (!source.includes(malformed)) throw new Error('missing malformed TaskDetailModel contract')
source = source.replace(malformed, repaired)

if (!source.includes('projectPiLiveTaskDetail') || !source.includes('projectPiLiveRunningRound')) {
  throw new Error('Pi TaskDetail projection contract is incomplete')
}

fs.writeFileSync(path, source.replace(/[ \t]+$/gm, ''))
