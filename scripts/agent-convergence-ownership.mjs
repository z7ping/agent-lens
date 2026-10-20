/**
 * Regression budgets are evidence of existing debt, NOT approval for new Agent
 * conditionals. Every count below must decrease to zero under epic #523.
 * This is a static boundary check, not a substitute for semantic/visual tests.
 */
export const CONVERGENCE_SOURCE_BUDGETS = Object.freeze({
  'packages/web/src/features/ReviewRoundPresentation.tsx': {
    'sourceId === codex': 2,
  },
  'packages/web/src/features/review-event-presentation.ts': {
    'sourceId === codex': 1,
    'sourceId === claude-code': 1,
    'sourceId === pi': 1,
  },
  'packages/web/src/features/review-interaction-presentation.ts': {
    'sourceId !== pi': 1,
  },
})

export const SHARED_TASK_OWNERS = Object.freeze([
  'packages/web/src/features/LiveTaskPage.tsx',
  'packages/web/src/features/ReviewPage.tsx',
  'packages/web/src/features/LiveTaskTimeline.tsx',
  'packages/web/src/features/TaskSessionContent.tsx',
  'packages/web/src/features/TaskMessage.tsx',
  'packages/web/src/components/TaskSessionComposer.tsx',
])

export const CONVERGENCE_CHECKED_PATHS = Object.freeze([
  ...SHARED_TASK_OWNERS,
  ...Object.keys(CONVERGENCE_SOURCE_BUDGETS),
  'packages/web/src/components/LiveRuntimeDisclosures.tsx',
])

const agentCompare = /\b(sourceId|productId|liveId|agentId)\s*(===|!==|==|!=)\s*(['"`])(pi|codex|hermes|claude-code)\3/g
const agentCompareReversed = /(['"`])(pi|codex|hermes|claude-code)\1\s*(===|!==|==|!=)\s*\b(sourceId|productId|liveId|agentId)\b/g

export function auditAgentConvergenceSources(sources) {
  const failures = []
  for (const [path, content] of Object.entries(sources)) {
    const remaining = { ...(CONVERGENCE_SOURCE_BUDGETS[path] ?? {}) }
    for (const match of content.matchAll(agentCompare)) {
      const key = `${match[1]} ${match[2]} ${match[4]}`
      remaining[key] = (remaining[key] ?? 0) - 1
      if (remaining[key] < 0) failures.push(`${path}: 新增 Agent 私有比较 ${key}（仅允许清除 #517 现存债务）`)
    }
    for (const match of content.matchAll(agentCompareReversed)) {
      const key = `${match[4]} ${match[3]} ${match[2]}`
      remaining[key] = (remaining[key] ?? 0) - 1
      if (remaining[key] < 0) failures.push(`${path}: 新增 Agent 私有比较 ${key}`)
    }

    if (SHARED_TASK_OWNERS.includes(path)) {
      if (path !== 'packages/web/src/components/TaskSessionComposer.tsx'
        && /<(?:LiveMarkdownComposer|ComposerPillSelect)(?:\s|\/?>)/.test(content)) {
        failures.push(`${path}: 通用页面/正文禁止自行渲染完整输入控件`)
      }
      if (/\b(?:import|require)\b[^\n]*PiLiveTaskRound/.test(content)) {
        failures.push(`${path}: 通用 Task Owner 不能依赖旧 PiLiveTaskRound`)
      }
      const piLegacy = (content.match(/pi-live-/g) ?? []).length
      const max = path.endsWith('/LiveTaskPage.tsx') ? 27 : 0
      if (piLegacy > max) failures.push(`${path}: 通用视图增加 pi-live-* 钩子（${piLegacy} > ${max}）；#519 只能减少`)
    }

    if (path.endsWith('/LiveRuntimeDisclosures.tsx')) {
      if (/field\.id\s*===?\s*['"](?:Main costs|Startup metrics|Extensions|Contexts|Package updates)['"]/.test(content)) {
        failures.push(`${path}: 扩展布局不能按英文 label 推断；见 #520`)
      }
      if (!content.includes('return field.section ??')) {
        failures.push(`${path}: 扩展布局必须通过结构化 section`)
      }
    }
  }
  return failures
}
