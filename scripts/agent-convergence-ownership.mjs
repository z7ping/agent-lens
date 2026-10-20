import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Regression budgets are evidence of existing debt, NOT approval for new Agent
 * conditionals. Every count below must decrease to zero under epic #523.
 * This is a static boundary check, not a substitute for semantic/visual tests.
 */
// No remaining UI-level Agent ID conditions are allowed in shared Review.
export const CONVERGENCE_SOURCE_BUDGETS = Object.freeze({})

export const SHARED_REVIEW_OWNERS = Object.freeze([
  'packages/web/src/features/ReviewRoundPresentation.tsx',
  'packages/web/src/features/review-event-presentation.ts',
  'packages/web/src/features/review-interaction-presentation.ts',
])

export const SHARED_TASK_OWNERS = Object.freeze([
  'packages/web/src/features/LiveTaskPage.tsx',
  'packages/web/src/features/ReviewPage.tsx',
  'packages/web/src/features/LiveTaskTimeline.tsx',
  'packages/web/src/features/TaskSessionContent.tsx',
  'packages/web/src/features/TaskMessage.tsx',
  'packages/web/src/components/TaskSessionComposer.tsx',
  'packages/web/src/features/TaskHeader.tsx',
  'packages/web/src/features/TaskFileChangesDisclosure.tsx',
  'packages/web/src/features/LiveExtensionPrompt.tsx',
])

export const CONVERGENCE_CHECKED_PATHS = Object.freeze([
  ...SHARED_TASK_OWNERS,
  ...SHARED_REVIEW_OWNERS,
  'packages/web/src/components/LiveRuntimeDisclosures.tsx',
  'packages/web/src/features/live-task-projection.ts',
  'packages/web/src/features/live-semantic-rounds.ts',
  'packages/web/src/features/live-task-state.ts',
  'packages/web/src/features/use-live-task-runtime.ts',
  'packages/web/src/features/use-live-task-history.ts',
  'packages/web/src/features/use-live-task-actions.ts',
  'packages/web/src/features/live-task-queue.ts',
  'packages/web/src/features/live-task-input.ts',
  'packages/web/src/features/live-task-history-window.ts',
  'packages/web/src/features/task-live-runtime.ts',
  'packages/web/src/live-task.css',
  'packages/web/src/components/live-runtime-disclosure.css',
])


/**
 * Discover all generic Task/Review/Live implementation files, including new
 * files added after this audit. Adapter-owned and unrelated pages are excluded.
 * Stable return paths match the checked-path keys independent of OS separator.
 */
export function discoverConvergencePaths(root = 'packages/web/src') {
  const found = []
  const sharedStem = /^(?:Task|Review|LiveTask|LiveExtensionPrompt|LiveRuntimeDisclosures|live-|review-|task-|use-live-|live-runtime-disclosure)/
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', '__fixtures__'].includes(entry.name)) walk(join(dir, entry.name))
      } else if (entry.isFile()
        && /\.(?:ts|tsx|js|jsx|css)$/.test(entry.name)
        && !/\.(?:test|spec|stories)\./.test(entry.name)
        && sharedStem.test(entry.name)) {
        found.push('packages/web/src/' + relative(root, join(dir, entry.name)).replaceAll('\\', '/'))
      }
    }
  }
  for (const folder of ['features', 'components']) walk(join(root, folder))
  return found.sort()
}

const agentCompare = /\b(?:[A-Za-z_$][\w$]*(?:\?\.|\.))*(sourceId|productId|liveId|agentId)\s*(===|!==|==|!=)\s*(['"`])(pi|codex|hermes|claude-code)\3/g
const agentCompareReversed = /(['"`])(pi|codex|hermes|claude-code)\1\s*(===|!==|==|!=)\s*\b(?:[A-Za-z_$][\w$]*(?:\?\.|\.))*(sourceId|productId|liveId|agentId)\b/g

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

    if ((path.endsWith('/LiveRuntimeDisclosures.tsx') || path.endsWith('/live-runtime-disclosure.css'))
      && content.includes('pi-startup-')) {
      failures.push(`${path}: 通用 Runtime Disclosure 禁止恢复 Pi 专属样式钩子`)
    }

    if ((path === 'packages/web/src/live-task.css'
      || /\/features\/(?:Task|Review|LiveTask|live-|review-|task-|use-live-)/.test(path))
      && content.includes('pi-live-')) {
      failures.push(`${path}: 通用 Task/Live 不能恢复 Pi 私有样式钩子`)
    }

    if (SHARED_TASK_OWNERS.includes(path) || /\/(?:features|components)\/(?:Task|Review|LiveTask|LiveExtensionPrompt|live-|review-|task-|use-live-)/.test(path)) {
      if (path !== 'packages/web/src/components/TaskSessionComposer.tsx'
        && /<(?:LiveMarkdownComposer|ComposerPillSelect)(?:\s|\/?>)/.test(content)) {
        failures.push(`${path}: 通用页面/正文禁止自行渲染完整输入控件`)
      }
      if (/\b(?:import|require)\b[^\n]*PiLiveTaskRound/.test(content)) {
        failures.push(`${path}: 通用 Task Owner 不能依赖旧 PiLiveTaskRound`)
      }
      const piLegacy = (content.match(/pi-live-/g) ?? []).length
      const max = 0
      if (piLegacy > max) failures.push(`${path}: 通用视图禁止 Pi 专属 pi-live-* 钩子（${piLegacy} > ${max}）；#519 只能减少`)
    }

    if (path.endsWith('/LiveRuntimeDisclosures.tsx')) {
      if (/field\.id\s*===?\s*['"](?:Main costs|Startup metrics|Extensions|Contexts|Package updates)['"]/.test(content)) {
        failures.push(`${path}: 扩展布局不能按英文 label 推断；见 #520`)
      }
      if (!content.includes("fields.filter(field => fieldSection(field) === 'performance')")) {
        failures.push(`${path}: Runtime performance 字段必须依照结构化 section 展示，禁止只识别 Pi 专用字段`)
      }
      if (!content.includes('switch (field.section)')) {
        failures.push(`${path}: 扩展布局必须通过结构化 section`)
      }
    }
  }
  return failures
}
