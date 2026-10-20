import { readFileSync, existsSync } from 'node:fs'
import { auditAgentConvergenceSources, CONVERGENCE_CHECKED_PATHS } from './agent-convergence-ownership.mjs'

const sources = {}
for (const path of CONVERGENCE_CHECKED_PATHS) {
  if (!existsSync(path)) throw new Error(`全量收敛门禁缺少被检查的共享组件: ${path}`)
  sources[path] = readFileSync(path, 'utf8')
}
const failures = auditAgentConvergenceSources(sources)
if (failures.length) throw new Error('AgentLens 全量收敛边界违规:\n' + failures.join('\n'))
console.log('AgentLens Agent 收敛门禁通过；旧例外额度仅能减少，跟踪 #517 / #519 / #523。')
