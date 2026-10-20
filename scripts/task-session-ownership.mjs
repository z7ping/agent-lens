import { readdirSync, readFileSync } from 'node:fs'
import { relative, join, extname } from 'node:path'
import ts from 'typescript'

// New agent implementations are data adapters, not alternative Task renderers.
// Exceptions are narrowly pinned to current owners, not directory/name patterns.
const directOwners = new Map([
  ['TaskMessage', new Set(['features/TaskSessionContent.tsx', 'features/PiLiveTaskRound.tsx'])],
  ['TaskThinking', new Set(['features/TaskSessionContent.tsx', 'features/TaskProcessGroup.tsx', 'features/ReviewRoundPresentation.tsx', 'features/PiLiveTaskRound.tsx'])],
  ['TaskToolRow', new Set(['features/TaskSessionContent.tsx', 'features/TaskToolGroup.tsx'])],
  ['TaskProcessGroup', new Set(['features/TaskSessionContent.tsx', 'features/PiLiveTaskRound.tsx'])],
])
const htmlOwners = new Map([
  ['task-message-row', new Set(['features/TaskMessage.tsx'])],
  ['task-thinking', new Set(['features/TaskThinking.tsx'])],
  ['task-tool-call', new Set(['features/TaskToolRow.tsx'])],
  ['task-process-group', new Set(['features/TaskProcessGroup.tsx', 'features/ReviewRoundPresentation.tsx'])],
  ['task-process-message', new Set(['features/TaskSessionContent.tsx', 'features/PiLiveTaskRound.tsx'])],
])
const sourceOwners = new Map([
  ['features/LiveTaskTimeline.tsx', 'TaskSessionContent'],
  ['features/ReviewRoundPresentation.tsx', 'TaskSessionContent'],
])
const cssOwner = 'task-detail.css'
const componentCss = /\.(?:task-(?:message|thinking|tool)(?:-[\w-]+)?|task-process-(?:group|message|summary)(?:-[\w-]+)?)(?![\w-])/
const agentPrivate = /(?:^|\s)[a-z][\w-]*-(?:live|review|session)(?:-task)?-(?:message|thinking|tool|process)(?:-[\w-]+)*(?=\s|$)/i

function* sourceFiles(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!['node_modules', 'dist', '__fixtures__'].includes(entry.name)) yield* sourceFiles(path)
    } else if (entry.isFile() && (entry.name.endsWith('.tsx') || entry.name.endsWith('.css'))) {
      if (!/\.test\.tsx$|\.spec\.tsx$/.test(entry.name)) yield path
    }
  }
}

function lineOf(node, file) {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1
}

function jsxTag(node) {
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return node.tagName.getText()
  return null
}

function inspectTsx(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const failures = []
  const required = sourceOwners.get(path)
  if (required) {
    // Both readers MUST consume the shared renderer; no new isolated page entry.
    const imports = file.statements.filter(ts.isImportDeclaration)
    if (!imports.some(node => node.moduleSpecifier.text.endsWith('/' + required) || node.moduleSpecifier.text === './' + required)) {
      failures.push(path + ': 缺少共享 TaskSessionContent 导入')
    }
  }
  function visit(node) {
    const tag = jsxTag(node)
    if (tag && directOwners.has(tag) && !directOwners.get(tag).has(path)) {
      failures.push(path + ':' + lineOf(node, file) + ': 禁止直接渲染 <' + tag + '>；使用 TaskSessionContent')
    }
    if (tag && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.text !== 'className' || !attr.initializer) continue
        // Strings in JSX expressions (including template literals) are inspected as well.
        const value = attr.initializer.getText(file).replace(/["'\x60{}]/g, ' ')
        for (const [name, owners] of htmlOwners) {
          const matchesClass = new RegExp('(?:^|\\s)' + name + '(?=\\s|$)').test(value)
          if (matchesClass && !owners.has(path)) failures.push(path + ':' + lineOf(node, file) + ': 私自构造 ' + name + ' DOM')
        }
        if (agentPrivate.test(value) && path !== 'features/PiLiveTaskRound.tsx') {
          failures.push(path + ':' + lineOf(node, file) + ': 智能体私有消息/过程样式；应使用共享 Task Session')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return failures
}

function inspectCss(source, path) {
  if (path === cssOwner) return []
  // Parse each selector block (including rules inside @media/@supports);
  // don't confuse declaration values or comments with selectors.
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const failures = []
  for (const match of clean.matchAll(/([^{}]+)\{/g)) {
    const selector = match[1].trim()
    if (selector.startsWith('@')) continue
    // CopyableCodeBlock owns only its nested copy control styling, even when embedded in Task output.
    if (path === 'components/copyable-code-block.css' && /\.(?:copyable-code-block|code-block-copy)(?![\w-])/.test(selector)) continue
    if (componentCss.test(selector)) failures.push(path + ': 越权定义 Task Session 样式 ' + selector.slice(0, 100))
    if (path !== 'live-task.css' && agentPrivate.test(selector.replaceAll('.', ' '))) {
      failures.push(path + ': 新增智能体私有 Session CSS ' + selector.slice(0, 100))
    }
  }
  return failures
}

export function auditTaskSessionOwnership(root = 'packages/web/src') {
  const errors = []
  for (const fullPath of sourceFiles(root)) {
    const path = relative(root, fullPath).replaceAll('\\', '/')
    const source = readFileSync(fullPath, 'utf8')
    if (extname(path) === '.tsx') errors.push(...inspectTsx(source, path))
    else errors.push(...inspectCss(source, path))
  }
  return errors
}
