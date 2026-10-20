import { readFileSync, existsSync } from 'node:fs'
import { auditAgentConvergenceSources, CONVERGENCE_CHECKED_PATHS, discoverConvergencePaths } from './agent-convergence-ownership.mjs'

const sources = {}
for (const path of new Set([...CONVERGENCE_CHECKED_PATHS, ...discoverConvergencePaths()])) {
  if (!existsSync(path)) throw new Error(`全量收敛门禁缺少被检查的共享组件: ${path}`)
  sources[path] = readFileSync(path, 'utf8')
}
const failures = auditAgentConvergenceSources(sources)
if (failures.length) throw new Error('AgentLens 全量收敛边界违规:\n' + failures.join('\n'))
console.log('AgentLens 通用 Task/Review/Live 全目录动态扫描与收敛门禁通过。')
