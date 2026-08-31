const fs = require('node:fs')
const path = 'scripts/check-pi-live-contract.mjs'
let source = fs.readFileSync(path, 'utf8')

function replace(pattern, after, label) {
  if (!pattern.test(source)) throw new Error(`missing ${label}`)
  source = source.replace(pattern, after)
}

replace(
  /const \[app, taskCenter, taskSurface, taskHeader, taskMessage, taskRound, taskThinking, taskToolGroup, taskToolRow, taskDetailModel, taskCenterCss, taskHeaderCss, reviewPage, page, hubPage, history,/,
  'const [app, taskCenter, taskSurface, taskHeader, taskMessage, taskRound, taskThinking, taskToolGroup, taskToolRow, taskDetailModel, taskCenterCss, taskHeaderCss, reviewPage, page, piTaskRound, piTaskProjection, hubPage, history,',
  'contract source tuple',
)
replace(
  /  readFile\(new URL\('\.\.\/packages\/web\/src\/features\/PiLivePage\.tsx', import\.meta\.url\), 'utf8'\),\n  readFile\(new URL\('\.\.\/packages\/web\/src\/features\/HubReviewPage\.tsx'/,
  "  readFile(new URL('../packages/web/src/features/PiLivePage.tsx', import.meta.url), 'utf8'),\n  readFile(new URL('../packages/web/src/features/PiLiveTaskRound.tsx', import.meta.url), 'utf8'),\n  readFile(new URL('../packages/web/src/features/pi-live-task-projection.ts', import.meta.url), 'utf8'),\n  readFile(new URL('../packages/web/src/features/HubReviewPage.tsx'",
  'Pi task contract sources',
)
replace(
  /requireText\(page, \/import \\\{ TaskMessage \\\} from '\\\.\\\/TaskMessage'\/, 'Pi Live 已完成消息必须接入统一 TaskMessage'\)\nrequireText\(page, \/item\\\.kind === 'message'\[\\s\\S\]\{0,320\}<TaskMessage\/, 'Pi Live 持久化消息必须通过 TaskMessage 渲染'\)\nrequireText\(page, \/streamText && <div className="pi-live-stream-response"\/, 'Pi Live Streaming Tail 必须保留独立实时渲染，不得误接源码切换'\)/,
  `requireText(page, /import \\{ PiLiveHistoryTaskRound, PiLiveRunningTaskRound \\} from '\\.\\/PiLiveTaskRound'/, 'Pi Live 页面必须通过薄 Adapter 进入共享 Task Round')
requireText(page, /projectPiLiveTaskRounds\\(history\\)/, 'Pi Live 历史事实必须先投影为共享 TaskRoundModel')
requireText(page, /historyRounds\\.map[\\s\\S]{0,720}<PiLiveHistoryTaskRound/, 'Pi Live 历史轮次必须通过 PiLiveHistoryTaskRound 渲染')
requireText(page, /<PiLiveRunningTaskRound[\\s\\S]{0,520}thinkingText=\\{thinkingText\\}[\\s\\S]{0,520}streamText=\\{streamText\\}/, 'Pi Live 当前轮次必须通过共享 Running TaskRound Adapter 渲染')
requireText(piTaskRound, /import \\{ TaskMessage \\} from '\\.\\/TaskMessage'/, 'Pi Live 已完成消息必须在 TaskRound Adapter 中接入统一 TaskMessage')
requireText(piTaskRound, /export function PiLiveHistoryTaskRound[\\s\\S]{0,2600}<TaskMessage/, 'Pi Live 持久化消息必须通过 TaskMessage 渲染')
requireText(piTaskRound, /export function PiLiveHistoryTaskRound[\\s\\S]{0,2600}<TaskThinking/, 'Pi Live 历史 Thinking 必须通过 TaskThinking 渲染')
requireText(piTaskRound, /export function PiLiveHistoryTaskRound[\\s\\S]{0,3200}<TaskToolGroup/, 'Pi Live 历史 Tool 必须通过 TaskToolGroup 渲染')
requireText(piTaskRound, /export function PiLiveRunningTaskRound[\\s\\S]{0,3200}<TaskRound/, 'Pi Live Running 状态必须复用 TaskRound')
requireText(piTaskRound, /streamText && <div className="pi-live-stream-response"/, 'Pi Live Streaming Tail 必须保留独立实时渲染，不得误接源码切换')
requireText(piTaskProjection, /export const PI_LIVE_HISTORY_ROUND_FACT_LIMIT = 8/, 'Pi Live 超长语义 Round 必须保留 8 Fact 显示分片上限')
requireText(piTaskProjection, /export function projectPiLiveTaskRounds/, 'Pi Live 缺少 History -> TaskRoundModel 投影')
if (/⌁/.test(\`${'${page}'}\\n${'${piTaskRound}'}\`)) failures.push('Pi Live Tool 不得恢复通用 ⌁ 占位图标，应统一使用 ToolKindIcon')`,
  'old Pi message/streaming contract',
)

fs.writeFileSync(path, source.replace(/[ \t]+$/gm, ''))
