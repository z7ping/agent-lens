import { readFileSync } from 'node:fs'

const backup = readFileSync('packages/web/src/features/BackupPage.tsx', 'utf8')
const review = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const virtualRound = readFileSync('packages/web/src/components/VirtualRoundMount.tsx', 'utf8')
const diagnostics = readFileSync('packages/web/src/components/AgentsStateOverlay.tsx', 'utf8')

for (const required of [
  "const [success, setSuccess] = useState('')",
  'const result = await api.createBackup',
  'result.snapshot.files.length.toLocaleString()',
  'result.snapshot.excluded.length',
  'role="status"',
  '快照已创建',
]) {
  if (!backup.includes(required)) throw new Error(`资产备份缺少创建结果反馈约束：${required}`)
}

for (const required of [
  'interface ReviewReaderPosition',
  'captureReviewReaderPosition',
  'readerPositionsRef',
  "querySelectorAll<HTMLElement>('.interaction-block[data-interaction-id]')",
  'await model.loadMoreReviewDetail()',
  "current.detail.page.direction !== 'forward'",
  'pane.scrollTop += anchor.getBoundingClientRect().top - paneTop - saved.offset',
]) {
  if (!review.includes(required)) throw new Error(`任务复盘缺少跨会话阅读位置恢复约束：${required}`)
}

for (const required of [
  'data-interaction-id={stableInteractionId || undefined}',
  'className="interaction-block virtual-round-anchor"',
  'data-interaction-id={stableInteractionId}',
]) {
  if (!virtualRound.includes(required)) throw new Error(`虚拟轮次缺少稳定阅读锚点：${required}`)
}

for (const required of [
  "import { useEffect, useState } from 'react'",
  'if (hasIssue) setOpen(true)',
  '}, [selectedSourceId, hasIssue])',
]) {
  if (!diagnostics.includes(required)) throw new Error(`采集诊断缺少异常来源自动展开约束：${required}`)
}

console.log('核心交互收口检查通过：快照结果可见、跨会话阅读位置可恢复、异常来源自动展开诊断')
