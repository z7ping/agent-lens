import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const self = 'components/icon-policy.test.ts'
const uiIcon = 'components/UiIcon.tsx'

async function sourceFiles(dir: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...await sourceFiles(path))
    else if (['.ts', '.tsx', '.css'].includes(extname(entry.name))) result.push(path)
  }
  return result
}

test('Web 通用操作图标只能经 UiIcon 进入业务层', async () => {
  const violations: string[] = []
  const directLucideImport = new RegExp(`from\\s+['"]${['lucide', 'react'].join('-')}['"]`)
  const inlineSvg = new RegExp(`<${['s', 'v', 'g'].join('')}(?:\\s|>)`, 'i')
  const dataSvg = ["data:image", 'svg+xml'].join('/')

  for (const path of await sourceFiles(sourceRoot)) {
    const file = relative(sourceRoot, path).replaceAll('\\\\', '/')
    if (file === self) continue
    const content = await readFile(path, 'utf8')

    if (file !== uiIcon && directLucideImport.test(content)) violations.push(`${file}: 业务层直接导入 lucide-react`)
    if (file !== uiIcon && inlineSvg.test(content)) violations.push(`${file}: 业务层手写 SVG`)
    if (content.includes(dataSvg)) violations.push(`${file}: 内嵌 data URI SVG`)
  }

  assert.deepEqual(violations, [])
})
