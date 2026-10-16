import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const component = readFileSync(new URL('./TaskFileChangesDisclosure.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8')
const reviewPage = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const live = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const reviewStyles = readFileSync(new URL('../review.css', import.meta.url), 'utf8')

test('Review renders file changes per round only; Live keeps its session-scoped card', () => {
  assert.match(review, /reviewInteractionFileChanges\(sessionId, \{[\s\S]*?id: interaction\.id,[\s\S]*?controller\.signal\)/)
  assert.match(review, /afterProcessEntries\.map\(renderEntry\)[\s\S]*?TaskFileChangesDisclosure/)
  assert.match(reviewPage, /fileChangesEnabled=\{Boolean\(review\.fileChanges\?\.summary\.count \|\| review\.fileChanges\?\.meta\.truncated\)\}/)
  assert.doesNotMatch(reviewPage, /detail\.interactionCount > 1/)
  assert.doesNotMatch(reviewPage, /TaskFileChangesDisclosure/)
  assert.match(review, /fileChangesEnabled && roundFileChanges\?\.interactionId === interaction\.id/)
  assert.match(review, /roundFileChanges\.summary\.count > 0 \|\| roundFileChanges\.meta\.truncated/)
  assert.doesNotMatch(review, /sessionFileChanges/)
  assert.match(review, /isConsolidatedFileChangeEvent\([\s\S]*?roundFileChanges\?\.interactionId === interaction\.id \? roundFileChanges : null/)
  assert.match(live, /runtimeFileChanges\(fileChangeRuntimeId/)
  assert.match(live, /<TaskFileChangesDisclosure key=\{fileChangeRuntimeId\}[\s\S]*?result : null\}/)
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
  assert.match(component, /confidence === 'exact' && !isObserved/)
  assert.match(component, /reviewFileDiff\(sessionId, diffPath/)
  assert.match(component, /<Drawer open/)
  assert.match(component, /<CopyableCodeBlock copyValue=\{diff\.diff\} language="diff"/)
})

test('legacy session with truncated evidence never disappears as an empty card', () => {
  assert.match(component, /value\.summary\.count === 0 && !value\.meta\.truncated/)
  assert.match(component, /value\?\.meta\.truncated && <div className="task-file-changes-error">/)
})
