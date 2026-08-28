import assert from 'node:assert/strict'
import test from 'node:test'
import { extractVersionSection, parseReleaseSections, renderReleaseNotes } from './render-release-notes.mjs'

const changelog = `## 1.0.0-alpha.2（2026-08-29）

### Changed
- 改进发布流程。

### Fixed
- 修复 npm 安装问题。

### Known limitations
- 暂不包含远程执行。

# 更新日志

## 1.0.0-alpha.1（2026-08-28）

### Fixed
- 旧版本内容。
`

test('只读取目标版本段落，不吞入历史版本', () => {
  const section = extractVersionSection(changelog, '1.0.0-alpha.2')
  assert.match(section, /改进发布流程/)
  assert.doesNotMatch(section, /旧版本内容/)
})

test('将 CHANGELOG 标题映射为中文 Release Notes 结构', () => {
  const sections = parseReleaseSections(extractVersionSection(changelog, '1.0.0-alpha.2'))
  assert.deepEqual(sections.map(section => section.title), ['改进', '修复', '已知限制'])

  const notes = renderReleaseNotes({
    changelog,
    version: '1.0.0-alpha.2',
    previousTag: 'v1.0.0-alpha.1',
  })
  assert.match(notes, /^## AgentLens v1\.0\.0-alpha\.2/m)
  assert.match(notes, /### 改进/)
  assert.match(notes, /### 修复/)
  assert.match(notes, /### 已知限制/)
  assert.match(notes, /compare\/v1\.0\.0-alpha\.1\.\.\.v1\.0\.0-alpha\.2/)
})

test('拒绝只有自动升版占位文案的发布说明', () => {
  const placeholder = `## 1.0.0-alpha.2（2026-08-29）

### Changed
- 版本更新至 1.0.0-alpha.2，详见本次发布说明。

## 1.0.0-alpha.1（2026-08-28）
`
  assert.throws(
    () => renderReleaseNotes({ changelog: placeholder, version: '1.0.0-alpha.2' }),
    /仍是占位说明/,
  )
})
