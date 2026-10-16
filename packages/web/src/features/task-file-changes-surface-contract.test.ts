import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const component = readFileSync(new URL('./TaskFileChangesDisclosure.tsx', import.meta.url), 'utf8')
const review = readFileSync(new URL('./ReviewRoundPresentation.tsx', import.meta.url), 'utf8')
const reviewPage = readFileSync(new URL('./ReviewPage.tsx', import.meta.url), 'utf8')
const live = readFileSync(new URL('./LiveTaskPage.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../task-detail.css', import.meta.url), 'utf8')
const reviewStyles = readFileSync(new URL('../review.css', import.meta.url), 'utf8')

test('Review and Live reuse one changed-file card after the conversation', () => {
  assert.match(review, /reviewInteractionFileChanges\(sessionId, interaction, controller\.signal\)/)
  assert.match(review, /afterProcessEntries\.map\(renderEntry\)[\s\S]*?TaskFileChangesDisclosure/)
  assert.match(reviewPage, /fileChangesEnabled=\{Boolean\(review\.fileChanges\?\.summary\.count\)\}/)
  assert.match(reviewPage, /annotatedInteractions\.map[\s\S]*?TaskFileChangesDisclosure/)
  assert.match(live, /runtimeFileChanges\(current\.runtimeSessionId/)
  assert.match(live, /<TaskFileChangesDisclosure key=\{fileChangeRuntimeId\}[\s\S]*?result : null\}/)
  assert.match(styles, /\.task-surface \.task-file-changes/)
  assert.doesNotMatch(reviewStyles, /\.task-file-changes\s*\{/)
})

test('Changed-file card keeps compact list, evidence, and real on-demand diff preview', () => {
  assert.match(component, /INITIAL_VISIBLE_FILES = 3/)
  assert.match(component, /confidence !== 'exact'/)
  assert.match(component, /confidence === 'exact' && !isObserved/)
  assert.match(component, /reviewFileDiff\(sessionId, diffPath/)
  assert.match(component, /<Drawer open/)
  assert.match(component, /<CopyableCodeBlock copyValue=\{diff\.diff\} language="diff"/)
})
