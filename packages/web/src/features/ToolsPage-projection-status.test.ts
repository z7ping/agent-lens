import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const pagePath = fileURLToPath(new URL('./ToolsPage.tsx', import.meta.url))

test('Tools page must visibly label partial Tool Fact projection instead of presenting it as complete', async () => {
  const source = await readFile(pagePath, 'utf8')
  assert.match(source, /data\?\.meta\.projection/)
  assert.match(source, /projection\?\.state === 'partial'/)
  assert.match(source, /历史工具索引正在回填，当前结果不完整/)
  assert.match(source, /projection\.projectedCount/)
  assert.match(source, /projection\.sourceObservationCount/)
})
