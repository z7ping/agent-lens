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
  assert.match(live, /infoPanel=\{fileChanges\?[\s\S]*?<TaskFileChangesDisclosure value=\{fileChanges\.result\} inlineDetails\/>/)
  assert.doesNotMatch(live, /<TaskFileChangesDisclosure key=/)
  assert.match(styles, /\.task-surface \.task-file-changes/)
  assert.doesNotMatch(reviewStyles, /\.task-file-changes\s*\{/)
})

test('Changed-file card keeps compact list, evidence, and real on-demand diff preview', () => {
  assert.match(component, /INITIAL_VISIBLE_FILES = 3/)
  assert.match(component, /<section className="task-file-changes">/)
  assert.match(component, /<div className="task-file-changes-header">/)
  assert.doesNotMatch(component, /<details\b/)
  assert.match(styles, /\.task-surface \.task-file-changes-header \{/)
  assert.match(component, /const displayed = showAll \? items : items\.slice\(0, INITIAL_VISIBLE_FILES\)/)
  assert.match(component, /const hidden = items\.length - displayed\.length/)
  assert.match(component, /\{hidden > 0 && <Button/)
  assert.match(component, /\{showAll && items\.length > INITIAL_VISIBLE_FILES && <Button/)
  assert.match(component, /isObservedOnly\(item\) \|\| isObserved/)
  assert.match(component, /!observedOnly && <Button/)
  assert.match(component, /observedOnly && <Button/)
  assert.match(component, /<Drawer open title=\{evidenceItem\.path\}/)
  assert.match(component, /reviewFileDiff\(sessionId, diffPath/)
  assert.match(component, /<Drawer open/)
  assert.match(component, /<CopyableCodeBlock copyValue=\{diff\.diff\} language="diff"/)
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

test('任务信息只切换同一个 Drawer 内子视图，Diff 和证据不再套 Drawer', () => {
  const header = readFileSync(new URL('./TaskHeader.tsx', import.meta.url), 'utf8')
  assert.match(header, /infoPanelOpen && infoPanel \?/)
  assert.match(header, /infoPanel\.content/)
  assert.match(component, /inlineDetails = false/)
  assert.match(component, /inspectingInline \? <section/)
  assert.match(component, /!inlineDetails && evidenceItem && <Drawer/)
  assert.match(component, /!inlineDetails && diffPath && <Drawer/)
})
