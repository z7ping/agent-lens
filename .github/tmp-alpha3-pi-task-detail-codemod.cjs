const fs = require('node:fs')
const path = 'packages/web/src/features/PiLivePage.tsx'
let source = fs.readFileSync(path, 'utf8')

function replace(pattern, after, label) {
  if (!pattern.test(source)) throw new Error(`missing ${label}`)
  source = source.replace(pattern, after)
}

replace(
  /import \{ projectPiLiveTaskRounds \} from '\.\/pi-live-task-projection'/,
  "import { piLiveTaskRoundEstimate, projectPiLiveRunningRound, projectPiLiveTaskDetail, projectPiLiveTaskRounds } from './pi-live-task-projection'",
  'Pi task projection import',
)
replace(
  /\nfunction statusLabel\(state: PiLiveStateDto \| null, connected: boolean\): string \{[\s\S]*?\n\}\n/,
  '\n',
  'old statusLabel',
)
replace(
  /\nfunction historyEstimate\(item: PiLiveHistoryItem\): number \{[\s\S]*?\n\}\n/,
  '\n',
  'old historyEstimate',
)
replace(
  /  const history = useMemo\(\(\) => projectPiLiveHistory\(snapshot\), \[snapshot\]\)\n  const historyRounds = useMemo\(\(\) => projectPiLiveTaskRounds\(history\), \[history\]\)\n/,
  `  const history = useMemo(() => projectPiLiveHistory(snapshot), [snapshot])
  const historyRounds = useMemo(() => projectPiLiveTaskRounds(history), [history])
  const runningRound = useMemo(() => {
    if (!thinkingText && tools.length === 0 && !streamText) return undefined
    return projectPiLiveRunningRound({ tools, isStreaming: state?.isStreaming ?? false })
  }, [state?.isStreaming, streamText, thinkingText, tools])
  const taskDetailModel = useMemo(() => projectPiLiveTaskDetail({
    state,
    connected,
    historyRounds,
    runningRound,
  }), [connected, historyRounds, runningRound, state])
`,
  'Pi task detail projection',
)
replace(
  /      <TaskHeader\n        marker=\{<span className=\{state\?\.isStreaming \? 'pi-live-pulse' : 'pi-live-idle-dot'\}\/\>}\n        agent="Pi"\n        context=\{modelLabel\(state\)\}\n        status=\{<>\{statusLabel\(state, connected\)\}\{!connected && <span className="pi-live-disconnected"> · 后台服务仍持有任务<\/span>\}<\/>\}\n        title=\{state\?\.sessionName \|\| 'Pi 实时任务'\}\n        metrics=\{\[\n          \{ value: state\?\.pendingMessageCount \?\? 0, label: '排队', tone: state\?\.pendingMessageCount \? 'accent' : undefined \},\n          \{ value: state\?\.processId \?\? '—', label: 'PID' \},\n        \]\}/,
  `      <TaskHeader
        marker={<span className={state?.isStreaming ? 'pi-live-pulse' : 'pi-live-idle-dot'}/>}
        agent={taskDetailModel.agentLabel}
        context={taskDetailModel.contextLabel}
        status={<span className={!connected ? 'pi-live-disconnected' : undefined}>{taskDetailModel.statusLabel}</span>}
        title={taskDetailModel.title}
        metrics={taskDetailModel.metrics}`,
  'Pi TaskHeader projection',
)
replace(
  /            estimate=\{projection\.items\.reduce\(\(total, item\) => total \+ historyEstimate\(item\), 0\) \+ 46\}/,
  '            estimate={piLiveTaskRoundEstimate(projection)}',
  'Pi history estimate',
)
replace(
  /          \{\(thinkingText \|\| tools\.length > 0 \|\| streamText\) && <PiLiveRunningTaskRound\n            thinkingText=\{thinkingText\}/,
  `          {runningRound && <PiLiveRunningTaskRound
            model={runningRound}
            thinkingText={thinkingText}`,
  'Pi running model consumer',
)

fs.writeFileSync(path, source.replace(/[ \t]+$/gm, ''))
