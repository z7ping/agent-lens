import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const productSurfaceFiles = [
  './TaskCenterPage.tsx',
  './LiveTaskPage.tsx',
  './LiveNewTaskPanel.tsx',
  './ReviewPage.tsx',
].map(path => ({ path, source: readFileSync(new URL(path, import.meta.url), 'utf8') }))

const liveComposer = readFileSync(new URL('../components/LiveMarkdownComposer.tsx', import.meta.url), 'utf8')
const runtimeDisclosures = readFileSync(new URL('../components/LiveRuntimeDisclosures.tsx', import.meta.url), 'utf8')
const taskLiveRuntimeList = readFileSync(new URL('./TaskLiveRuntimeList.tsx', import.meta.url), 'utf8')
const liveTaskProjection = readFileSync(new URL('./live-task-projection.ts', import.meta.url), 'utf8')
const liveTaskRenderBoundary = readFileSync(new URL('./live-task-render-boundary.ts', import.meta.url), 'utf8')

test('统一 Product Surface 不直接依赖 Pi Live 兼容 Client 或页面', () => {
  for (const file of productSurfaceFiles) {
    assert.doesNotMatch(file.source, /piLiveApi|PiLivePage|PiLiveCompatibilityPage/, file.path)
  }
})

test('统一 Product Surface 不使用具体 Agent 名称决定行为', () => {
  const forbidden = [
    /sourceIds\.includes\(\s*['"](?:pi|hermes|claude-code|codex)['"]\s*\)/,
    /(?:sourceId|liveId|productId|agentId)\s*={2,3}\s*['"](?:pi|hermes|claude-code|codex)['"]/,
    /['"](?:pi|hermes|claude-code|codex)['"]\s*={2,3}\s*(?:sourceId|liveId|productId|agentId)/,
  ]
  for (const file of productSurfaceFiles) {
    for (const pattern of forbidden) assert.doesNotMatch(file.source, pattern, file.path)
  }
})

test('Review 通用产品层不保留 Pi 专属关系树命名', () => {
  const review = productSurfaceFiles.find(file => file.path === './ReviewPage.tsx')!.source
  assert.doesNotMatch(review, /pi-session-tree|local\.relationship\.piTree/)
  assert.match(review, /session-relationship-tree/)
  assert.match(review, /local\.relationship\.sessionTree/)
})

test('具体 Agent 的 Review 事件解释只能留在 Product Presentation 投影', () => {
  const presentation = readFileSync(new URL('./review-event-presentation.ts', import.meta.url), 'utf8')
  assert.match(presentation, /codex|claude-code|pi/)
  const review = productSurfaceFiles.find(file => file.path === './ReviewPage.tsx')!.source
  assert.doesNotMatch(review, /node\.sourceId\s*===\s*['"](?:pi|hermes|claude-code|codex)['"]/)
})


test('LiveTask 高级交互只消费通用 capability 与 control，不解析 Pi 原生字段', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  for (const capability of ['model-switching', 'thinking-control', 'extension-ui', 'command-discovery', 'recovery', 'steer', 'queue']) {
    assert.match(liveTask, new RegExp(`capabilities\\.includes\\(['"]${capability}['"]\\)`), capability)
  }
  assert.match(liveTask, /liveApi\.modelControl/)
  assert.match(liveTask, /liveApi\.respondToExtension/)
  assert.match(liveTask, /liveApi\.queueState/)
  assert.match(liveTask, /liveApi\.clearQueue/)
  assert.match(liveTask, /onSubmit=\{\(message, mode\) => \{ void send\(message, mode === 'followUp' \? 'follow-up' : undefined\) \}\}/)
  assert.match(liveTask, /normalizedEvent\?\.type === 'queue\.update'/)
  assert.match(liveTask, /normalizedEvent\?\.type === 'control\.changed'/)
  assert.match(liveTask, /event\.type === 'title\.update'/)
  assert.match(liveTask, /liveApi\.snapshot\(current\.liveId, current\.runtimeSessionId, recoveryLeafId\)/)
  assert.doesNotMatch(liveTask, /queue_update|extension_ui_request|modelId|provider/)
})


test('@文件补全保持 Runtime-bound 通用 Live Product 边界', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /capabilities\.includes\('workspace-file-reference'\)/)
  assert.match(liveTask, /liveApi\.workspaceFileReferences\(current\.liveId, current\.runtimeSessionId, query, 20\)/)
  assert.match(liveTask, /workspaceReferenceSearch=/)
  assert.doesNotMatch(liveTask, /workspacePath[\s\S]{0,120}workspaceFileReferences|liveId\s*===\s*['"]pi['"]/)

  assert.match(liveComposer, /function WorkspaceReferenceMenuPlugin/)
  assert.match(liveComposer, /workspaceReferenceQueryFromEditor/)
  assert.match(liveComposer, /insertWorkspaceReference/)
  assert.match(liveComposer, /COMMAND_PRIORITY_CRITICAL/)
  assert.match(liveComposer, /event\.isComposing/)
  assert.match(liveComposer, /event\.keyCode !== 229/)
  assert.doesNotMatch(liveComposer, /\bpi\b|Pi Live/)
})

test('Runtime 私有诊断通过次级 Disclosure Contribution 暴露，不污染任务正文', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /liveApi\.runtimeDisclosures\(current\.liveId, current\.runtimeSessionId\)/)
  assert.match(liveTask, /liveApi\.executeRuntimeAction\(/)
  assert.match(liveTask, /<LiveRuntimeDisclosures/)
  assert.match(
    liveTask,
    /<div className="pi-live-document live-task-document">[\s\S]{0,500}<LiveRuntimeDisclosures/,
    'runtime disclosures must stay inside the Session Document without creating a fourth TaskSurface slot',
  )
  assert.doesNotMatch(
    liveTask,
    /<TaskHeader[\s\S]{0,1800}<LiveRuntimeDisclosures[\s\S]{0,300}<div[\s\S]{0,120}className="pi-live-reader/,
  )

  assert.match(runtimeDisclosures, /AgentLens-owned|LiveRuntimeDisclosureContributionDto/)
  assert.match(runtimeDisclosures, /<Disclosure/)
  assert.match(runtimeDisclosures, /<CopyableCodeBlock/)
  assert.doesNotMatch(runtimeDisclosures, /\bPi\b|pi\.runtime|initializationStage|startupResources|runtimeMode/)
  assert.doesNotMatch(liveTask, /pi\.runtime\.retry|initializationStage|startupResources|runtimeMode|processId/)
})

test('Live Snapshot 附件通过通用 TaskMessage 展示', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTaskProjection, /messageAttachments\(item, nested\)/)
  assert.match(liveTask, /attachments=\{item\.attachments\}/)
  assert.match(liveTask, /optimisticImageAttachments\(message\)/)
  assert.match(liveTask, /URL\.createObjectURL\(await response\.blob\(\)\)/)
})

test('消息级私有动作通过受控 Contribution 暴露，不提升为 Pi 专属 Product 分支', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /liveApi\.messageActions\(current\.liveId, current\.runtimeSessionId\)/)
  assert.match(liveTask, /liveApi\.executeMessageAction\(/)
  assert.match(liveTask, /action\.actionId/)
  assert.match(liveTask, /action\.roles\.includes\(item\.role\)/)
  assert.match(liveTask, /action\.requiresIdle/)
  assert.match(liveTask, /item\.entryId/)
  assert.doesNotMatch(liveTask, /pi\.edit-from-here|pi\.new-session-from-here|navigateTree|createBranchedSession/)
})

test('Slash 命令发现保持通用 Live Product 边界', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /capabilities\.includes\('command-discovery'\)/)
  assert.match(liveTask, /liveApi\.commands\(current\.liveId, current\.runtimeSessionId\)/)
  assert.match(liveTask, /commands=\{commands\}/)
  assert.doesNotMatch(liveTask, /get_commands|BUILTIN_SLASH_COMMANDS|command\.source\s*===\s*['"](?:extension|prompt|skill)['"]/)

  assert.match(liveComposer, /function CommandMenuPlugin/)
  assert.match(liveComposer, /COMMAND_PRIORITY_CRITICAL/)
  assert.match(liveComposer, /replacePlainTextDocument\(editor, `\$\{command\.value\} `\)/)
  assert.match(liveComposer, /className="select-menu-popover live-command-menu"/)
  assert.doesNotMatch(liveComposer, /\bpi\b|Pi Live|BUILTIN_SLASH_COMMANDS/)
})

test('Live Composer 草稿与输入历史留在 Composer 边界内', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /liveComposerDraftKey\(current\.liveId, current\.runtimeSessionId\)/)
  assert.match(liveTask, /readLiveComposerDraft\(composerDraftKey\)/)
  assert.match(liveTask, /draftKey=\{composerDraftKey \|\| undefined\}/)
  assert.match(liveTask, /inputHistory=\{inputHistory\}/)
  assert.match(liveTask, /setInputHistory\(previous => appendLiveInputHistory\(previous, optimisticText\)\)/)
  assert.match(liveTask, /composerRef\.current\?\.restoreMessage\(message\)/)

  assert.match(liveComposer, /function DraftPersistencePlugin/)
  assert.match(liveComposer, /writeLiveComposerDraft\(pending\.key, draftTextFromEditor\(pending\.state\)\)/)
  assert.match(liveComposer, /KEY_ARROW_UP_COMMAND/)
  assert.match(liveComposer, /KEY_ARROW_DOWN_COMMAND/)
  assert.match(liveComposer, /event\.isComposing/)
  assert.match(liveComposer, /event\.keyCode !== 229/)
  assert.match(liveComposer, /restoreMessageBeforeCurrentDraft/)
  assert.doesNotMatch(liveTask, /onDraftChange=/)
})


test('LiveTask migration keeps the full session-view shell instead of only the generic protocol', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  const styles = readFileSync(new URL('../pi-live.css', import.meta.url), 'utf8')

  assert.match(styles, /grid-template-columns:\s*var\(--pi-live-side\)\s+minmax\(0,\s*1fr\)/)
  assert.match(liveTask, /<aside className="pi-live-sessions"/)
  assert.match(liveTask, /setRuntimes\(matched\.runtimes\)/)
  assert.match(liveTask, /LiveTaskRoundProjector/)
  assert.match(liveTask, /roundProjectorRef\.current\.projectSegments\(projection\.stable, projection\.active\)/)
  assert.match(liveTaskProjection, /liveTaskStableRoundPrefixLength/)
  assert.match(liveTaskProjection, /liveEventChangesTaskTranscript/)
  assert.match(liveTaskRenderBoundary, /sameStableLiveTaskRoundProps/)
  assert.match(liveTask, /<GenericLiveRound/)
  assert.match(liveTask, /<VirtualRoundMount/)
  assert.match(liveTask, /<TaskRound/)
  assert.match(liveTask, /new LiveFollowController\(\)/)
  assert.match(liveTask, /ref=\{readerRef\}/)
  assert.match(liveTask, /onScroll=\{onReaderScroll\}/)
  assert.match(liveTask, /pi-live-new-records/)
  assert.doesNotMatch(liveTask, /\{items\.map\(item => <GenericLiveItem/)
})

test('通用 Live 标题在任务中心与 Live 会话栏保持一致', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /runtime\.title\?\.trim\(\) \|\| workspaceDisplayName/)
  assert.match(liveTask, /state\?\.title\?\.trim\(\) \|\| workspace/)
  assert.match(taskLiveRuntimeList, /item\.state\.title\?\.trim\(\) \|\| workspace \|\| fallback/)
})

test('LiveTask session sidebar stays agent-neutral', () => {
  const liveTask = productSurfaceFiles.find(file => file.path === './LiveTaskPage.tsx')!.source
  assert.match(liveTask, /current\.liveId/)
  assert.match(liveTask, /product\.productId/)
  assert.doesNotMatch(liveTask, /piLiveApi|PiLivePage|sourceId\s*===\s*['"]pi['"]/)
})
