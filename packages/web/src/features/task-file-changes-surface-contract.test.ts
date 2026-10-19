import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const component = readFileSync(new URL('./TaskFileChangesDisclosure.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8')
const reviewPage = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const live = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const reviewStyles = readFileSync(new URL('../review.css', import.meta.url), 'utf8')

test('会话级文件归入任务信息，Review 逐轮文件仍留在轮次末尾', () => {
  assert.match(review, /reviewInteractionFileChanges\(sessionId, \{[\s\S]*?id: interaction\.id,[\s\S]*?controller\.signal\)/)
  assert.match(review, /afterProcessEntries\.map\(renderEntry\)[\s\S]*?TaskFileChangesDisclosure/)
  assert.match(reviewPage, /fileChangesEnabled=\{Boolean\(review\.fileChanges\?\.summary\.count \|\| review\.fileChanges\?\.meta\.truncated\)\}/)
  assert.doesNotMatch(reviewPage, /detail\.interactionCount > 1/)
  assert.match(reviewPage, /infoPanel=\{review\.fileChanges[\s\S]*?<TaskFileChangesDisclosure value=\{review\.fileChanges\} inlineDetails\/>/)
  assert.match(review, /fileChangesEnabled && roundFileChanges\?\.interactionId === interaction\.id/)
  assert.match(review, /roundFileChanges\.summary\.count > 0 \|\| roundFileChanges\.meta\.truncated/)
  assert.doesNotMatch(review, /sessionFileChanges/)
  assert.match(review, /isConsolidatedFileChangeEvent\([\s\S]*?roundFileChanges\?\.interactionId === interaction\.id \? roundFileChanges : null/)
  assert.match(live, /runtimeFileChanges\(fileChangeRuntimeId/)
  assert.match(live, /infoPanel=\{fileChanges !== null &&[\s\S]*?<TaskFileChangesDisclosure value=\{fileChanges\.result\} inlineDetails\/>/)
  assert.doesNotMatch(live, /<TaskFileChangesDisclosure key=/)
  assert.match(styles, /:is\(\.task-surface, \.task-header-info-drawer\) \.task-file-changes/)
  assert.doesNotMatch(reviewStyles, /\.task-file-changes\s*\{/)
})

test('Changed-file card keeps compact list, evidence, and real on-demand diff preview', () => {
  assert.match(component, /INITIAL_VISIBLE_FILES = 3/)
  assert.match(component, /<section className="task-file-changes">/)
  assert.match(component, /<div className="task-file-changes-header">/)
  assert.doesNotMatch(component, /<details\b/)
  assert.match(styles, /:is\(\.task-surface, \.task-header-info-drawer\) \.task-file-changes-header \{/)
  assert.match(component, /const displayed = inlineDetails \|\| showAll \? items : items\.slice\(0, INITIAL_VISIBLE_FILES\)/)
  assert.match(component, /const hidden = items\.length - displayed\.length/)
  assert.match(component, /\{hidden > 0 && <Button/)
  assert.match(component, /\{showAll && items\.length > INITIAL_VISIBLE_FILES && <Button/)
  assert.match(component, /isObservedOnly\(item\) \|\| isObserved/)
  assert.match(component, /!observedOnly && <Button/)
  assert.match(component, /observedOnly && <Button/)
  assert.match(component, /<Drawer open title=\{evidenceItem\.path\}/)
  assert.match(component, /reviewFileDiff\(sessionId, diffPath/)
  assert.match(component, /<Drawer open/)
  assert.match(component, /<PatchDiff patch=\{diff\.diff\} options=\{\{/)
  assert.match(component, /diff\.truncated[\s\S]*?<CopyableCodeBlock copyValue=\{diff\.diff\} language="diff"/)
})

test('查看差异交由 Pierre PatchDiff 负责解析、行号、主题及增删展示', () => {
  const packageJson = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  const packageLock = readFileSync(new URL('../../../../package-lock.json', import.meta.url), 'utf8')
  assert.match(packageJson, /"@pierre\/diffs": "1\.5\.2"/)
  assert.match(packageLock, /"node_modules\/@pierre\/diffs": \{\s*"version": "1\.5\.2"/)
  assert.match(component, /import \{ PatchDiff \} from '@pierre\/diffs\/react'/)
  assert.match(component, /<PatchDiff patch=\{diff\.diff\} options=\{\{/)
  assert.match(component, /diffStyle: diffLayout/)
  assert.match(component, /theme: diffTheme === 'dark' \? 'pierre-dark' : 'pierre-light'/)
  assert.match(component, /hunkSeparators: 'line-info'/)
  assert.match(component, /attributeFilter: \['data-theme'\]/)
  assert.match(component, /role="group" aria-label=\{t\('local\.fileChanges\.diffLayout'\)\}/)
  assert.match(component, /aria-pressed=\{diffLayout === 'unified'\}/)
  assert.match(component, /aria-pressed=\{diffLayout === 'split'\}/)
  assert.match(component, /await copyText\(diff\.diff\)/)
  assert.match(styles, /\.task-file-diff-toolbar \{/)
  assert.match(styles, /\.task-file-diff-code \{/)
  assert.doesNotMatch(styles, /\.task-file-diff-block \.token-(inserted|deleted)/)
})

test('legacy session with truncated evidence never disappears as an empty card', () => {
  assert.match(component, /value\.summary\.count === 0 && !value\.meta\.truncated/)
  assert.match(component, /value\?\.meta\.truncated && <div className="task-file-changes-error">/)
})

test('仅精确 Session 事实允许查看 Git Diff；逐轮观测只展示来源，不假冒 Diff', () => {
  assert.match(component, /change\.confidence !== 'exact' \|\| change\.changeType === 'unknown'/)
  assert.match(component, /observedOnly = isObservedOnly\(item\) \|\| isObserved/)
  assert.match(component, /observedOnly \? t\('local\.fileChanges\.observed'\) : statusCode\(item\)/)
  assert.match(component, /const \[evidenceItem, setEvidenceItem\]/)
  assert.match(component, /evidenceItem\.firstChangedAt/)
  assert.match(component, /evidenceItem\.lastChangedAt/)
  assert.match(component, /evidenceItem\.evidence\.map/)
  assert.match(component, /if \(!diffPath \|\| !sessionId \|\| isInteraction\) return/)
  assert.doesNotMatch(component, /return '\?'/)
})

test('会话文件列表在任务信息抽屉第一层，Diff 和证据在同一抽屉切换', () => {
  const header = readFileSync(new URL('./TaskHeader.tsx', import.meta.url), 'utf8')
  assert.match(header, /<section className="task-header-compact-info-list"/)
  assert.match(header, /\{infoPanel && <div className="task-header-info-panel-content" aria-label=\{infoPanel\.label\}>/)
  assert.match(header, /\{infoPanel\.content\}/)
  assert.doesNotMatch(header, /infoPanelOpen|setInfoPanelOpen|task-header-info-panel-trigger/)
  assert.match(styles, /\.task-header-info-panel-content \{/)
  assert.match(component, /inlineDetails = false/)
  assert.match(component, /const displayed = inlineDetails \|\| showAll \?/)
  assert.match(component, /inspectingInline \? <section/)
  assert.match(component, /!inlineDetails && evidenceItem && <Drawer/)
  assert.match(component, /!inlineDetails && diffPath && <Drawer/)
})

test('抽屉中的会话文件列表复用正文同一份样式定义', () => {
  assert.match(styles, /:is\(\.task-surface, \.task-header-info-drawer\) \.task-file-change-row/)
  assert.match(styles, /:is\(\.task-surface, \.task-header-info-drawer\) \.task-file-changes-more/)
})

test('点击文件进入同层详情：文件身份、核验结论、观测时间与原始证据分级呈现', () => {
  assert.match(component, /const inspectedFile = fileNameAndDirectory\(inspectedFilePath\)/)
  assert.match(component, /className="task-file-detail-heading"/)
  assert.match(component, /className="task-file-detail-identity"/)
  assert.match(component, /local\.fileChanges\.backToFiles/)
  assert.match(component, /className="task-file-change-verdict" role="status"/)
  assert.match(component, /className="task-file-change-explanation"/)
  assert.match(component, /className="task-file-change-facts"/)
  assert.match(component, /firstChangedAt === evidenceItem\.lastChangedAt/)
  assert.match(component, /firstChangedAt !== evidenceItem\.lastChangedAt/)
  assert.match(component, /<Disclosure className="task-file-change-raw"/)
  assert.doesNotMatch(component, /<details\b/)
  assert.match(styles, /\.task-file-change-raw\.ui-disclosure \{/)
  assert.match(styles, /\.task-file-detail-heading \{/)
})

test('文件观测与准确变更的标题语义分离，详情文案双语覆盖', () => {
  const zh = readFileSync(new URL('../i18n/zh-CN/review.ts', import.meta.url), 'utf8')
  const en = readFileSync(new URL('../i18n/en-US/review.ts', import.meta.url), 'utf8')
  assert.match(component, /hasUnverifiedFiles = Boolean\(/)
  assert.match(component, /hasUnverifiedFiles \? 'local\.fileChanges\.activityCount' : 'local\.fileChanges\.titleCount'/)
  for (const messages of [zh, en]) {
    for (const key of ['activityCount', 'observedVerdict', 'backToFiles', 'rawEvidence', 'observedAt', 'sessionObservationDisclaimer']) {
      assert.ok(messages.includes(key + ':'), `missing ${key}`)
    }
  }
})
