import { readFileSync } from 'node:fs'

const reviewPage = readFileSync('packages/web/src/features/ReviewPage.tsx', 'utf8')
const reviewCss = readFileSync('packages/web/src/review.css', 'utf8')
const longCss = readFileSync('packages/web/src/review-long-session.css', 'utf8')
const mockup = readFileSync('docs/design/mockups/v2/review.html', 'utf8')

const requiredActions = ['从头查看', '跳到最新', '有新记录']
for (const label of requiredActions) {
  if (!mockup.includes(label)) throw new Error(`冻结任务复盘原型缺少关键长会话操作：${label}`)
  if (!reviewPage.includes(label)) throw new Error(`正式任务复盘缺少冻结交互：${label}`)
}

for (const label of ['查看源码', '证据详情']) {
  if (!reviewPage.includes(label)) throw new Error(`正式任务复盘缺少消息操作：${label}`)
}

if (/\.round-nav[^{}]*\{[^{}]*display\s*:\s*none/gs.test(longCss)
  || /\.round-nav[^,{]*[^{}]*\{[^{}]*visibility\s*:\s*hidden/gs.test(longCss)) {
  throw new Error('长会话性能层不得隐藏任务复盘导航或业务操作')
}
if (/\.round-nav\s*>\s*button:nth-of-type/.test(longCss)) {
  throw new Error('长会话性能层不得按按钮序号修改业务操作表现；请使用语义类并由 review.css 所有')
}
if (/\.round-nav[^\n{]*\[[^\]]*(?:data-|aria-)[^\]]*\][^{}]*\{[^{}]*(?:display|visibility)\s*:/gs.test(longCss)) {
  throw new Error('长会话性能层不得根据业务状态属性控制导航可见性')
}

if (!/\.round-nav\s+button\s*\{[^}]*white-space:\s*nowrap/s.test(reviewCss)) {
  throw new Error('任务复盘正式所有者必须保证长会话操作单行展示')
}
if (!longCss.includes('消息操作栏必须是一个视觉行')
  || !/\.chat-bubble \.markdown-message-actions,[\s\S]*?\.chat-bubble > \.chat-actions\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?white-space:\s*nowrap;/m.test(longCss)) {
  throw new Error('用户/智能体消息的源码与证据操作必须保持同一视觉行')
}

console.log('任务复盘冻结交互契约检查通过：关键入口存在，性能 CSS 不得隐藏业务操作，消息操作保持单行')
