import { readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

const ROOT = resolve('packages/web/src')
const OFFICIAL_BASELINE = resolve(ROOT, 'i18n/official-zh-CN.ts')
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

function ignored(path) {
  return path === OFFICIAL_BASELINE
    || /\.test\.[cm]?[jt]sx?$/.test(path)
    || /\.spec\.[cm]?[jt]sx?$/.test(path)
}

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collect(path))
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !ignored(path)) files.push(path)
  }
  return files
}

function sourceFile(path, source) {
  const kind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind)
}

function propertyName(property) {
  const name = property.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function officialMessagesObject(file) {
  let found = null
  const visit = node => {
    if (found) return
    if (ts.isPropertyAssignment(node)
      && propertyName(node) === 'messages'
      && ts.isObjectLiteralExpression(node.initializer)) {
      found = node.initializer
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

function collectOfficialKeys(messages, file) {
  const keys = new Set()
  const problems = []

  const visitObject = (object, prefix) => {
    const local = new Set()
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue
      const name = propertyName(property)
      if (!name) continue
      const path = [...prefix, name]
      const joined = path.join('.')
      if (local.has(name)) {
        const { line, character } = file.getLineAndCharacterOfPosition(property.getStart(file))
        problems.push(`duplicate official key ${joined} at ${line + 1}:${character + 1}`)
      }
      local.add(name)

      if (ts.isObjectLiteralExpression(property.initializer)) {
        visitObject(property.initializer, path)
      } else if (ts.isStringLiteralLike(property.initializer)) {
        keys.add(joined)
      } else {
        const { line, character } = file.getLineAndCharacterOfPosition(property.getStart(file))
        problems.push(`official key ${joined} must be a string or nested object at ${line + 1}:${character + 1}`)
      }
    }
  }

  visitObject(messages, [])
  return { keys, problems }
}

function literalText(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : null
}

function translationNamespaceForFunction(node) {
  if (!node.body || !ts.isBlock(node.body)) return null
  for (const statement of node.body.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isObjectBindingPattern(declaration.name)
        || !declaration.name.elements.some(element => element.name.getText() === 't')
        || !declaration.initializer
        || !ts.isCallExpression(declaration.initializer)
        || declaration.initializer.expression.getText() !== 'useTranslation') continue

      const argument = declaration.initializer.arguments[0]
      const direct = literalText(argument)
      if (direct) return direct
      if (argument && ts.isArrayLiteralExpression(argument)) {
        for (const element of argument.elements) {
          const value = literalText(element)
          if (value) return value
        }
      }
    }
  }
  return null
}

function candidateChineseText(node, file) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
    || node.kind === ts.SyntaxKind.JsxText) {
    return node.getText(file)
  }
  return ''
}

function normalizedKey(raw, namespace) {
  if (raw.includes(':')) return raw.replace(':', '.')
  return namespace ? `${namespace}.${raw}` : null
}

const officialSource = await readFile(OFFICIAL_BASELINE, 'utf8')
const officialFile = sourceFile(OFFICIAL_BASELINE, officialSource)
const messages = officialMessagesObject(officialFile)
if (!messages) {
  console.error('Web i18n gate failed: official zh-CN messages object was not found.')
  process.exit(1)
}
const { keys: officialKeys, problems: officialProblems } = collectOfficialKeys(messages, officialFile)
const violations = officialProblems.map(problem => ({ path: relative(process.cwd(), OFFICIAL_BASELINE).replaceAll('\\', '/'), line: 0, column: 0, text: problem }))

for (const path of await collect(ROOT)) {
  const source = await readFile(path, 'utf8')
  const file = sourceFile(path, source)

  const visit = (node, namespace = null) => {
    let currentNamespace = namespace
    if (ts.isFunctionLike(node)) {
      currentNamespace = translationNamespaceForFunction(node) ?? namespace
    }

    const chinese = candidateChineseText(node, file)
    if (chinese && CJK.test(chinese)) {
      const start = node.getStart(file)
      const { line, character } = file.getLineAndCharacterOfPosition(start)
      violations.push({
        path: relative(process.cwd(), path).replaceAll('\\', '/'),
        line: line + 1,
        column: character + 1,
        text: `production Chinese copy: ${chinese.replace(/\s+/g, ' ').trim().slice(0, 140)}`,
      })
    }

    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const raw = literalText(node.arguments[0])
      let key = null
      if (raw && ts.isIdentifier(node.expression) && node.expression.text === 'translateProduct') {
        key = normalizedKey(raw, null)
      } else if (raw
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(file) === 'agentLensI18n'
        && node.expression.name.text === 't') {
        key = normalizedKey(raw, null)
      } else if (raw && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        key = normalizedKey(raw, currentNamespace)
      }

      if (key && !officialKeys.has(key)) {
        const start = node.getStart(file)
        const { line, character } = file.getLineAndCharacterOfPosition(start)
        violations.push({
          path: relative(process.cwd(), path).replaceAll('\\', '/'),
          line: line + 1,
          column: character + 1,
          text: `missing official zh-CN key: ${key}`,
        })
      }
    }

    ts.forEachChild(node, child => visit(child, currentNamespace))
  }

  visit(file)
}

if (violations.length) {
  console.error('Web i18n gate failed:')
  for (const item of violations) {
    const location = item.line ? `:${item.line}:${item.column}` : ''
    console.error(`- ${item.path}${location} ${item.text}`)
  }
  process.exit(1)
}

console.log(`Web i18n gate passed: ${officialKeys.size} official zh-CN keys are unique; production copy and statically resolvable i18n references are valid.`)
