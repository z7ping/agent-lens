import { useRef, useState } from 'react'
import type { LiveCommandDto, LiveEventDto, LiveHistoryIndexDto, LiveMessageActionContributionDto, LiveModelControlDto, LiveQueueStateDto, LiveRuntimeDisclosureContributionDto, LiveRuntimeStateDto, LiveSnapshotDto, LiveThinkingControlDto, LiveMessageDto } from '@agent-lens/protocol'
import type { LiveProductMetadata } from '../client/live'
import { LiveFollowController } from './live-follow-controller'
import { LiveTaskRoundProjector, type LiveTaskProjectionItem } from './live-task-projection'
import type { LiveHistoryPageBlock } from './live-task-history-window'
import { type LiveMarkdownComposerDraft, type LiveMarkdownComposerHandle } from '../components/LiveMarkdownComposer'
import { emptyLiveQueue, type PendingQueueSubmission, type RestoredQueueDraft, type LiveQueueMode } from './live-task-queue'

type LiveUiRequest = Extract<LiveEventDto, { type: 'ui.request' }>

/** Live 会话单一状态所有者；运行时、历史、操作 Hook 按领域消费同一引用。 */
export function useLiveTaskState() {
  const [product, setProduct] = useState<LiveProductMetadata | null>(null)
  const [state, setState] = useState<LiveRuntimeStateDto | null>(null)
  const [projection, setProjection] = useState<{
    stable: LiveTaskProjectionItem[]
    active: LiveTaskProjectionItem[]
  }>({ stable: [], active: [] })
  const [historyPage, setHistoryPage] = useState<LiveSnapshotDto['page'] | null>(null)
  const [historyIndex, setHistoryIndex] = useState<LiveHistoryIndexDto | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyPagingArmed, setHistoryPagingArmed] = useState(false)
  const [historyPagingDirection, setHistoryPagingDirection] = useState<'older' | 'newer' | null>(null)
  const [messageActions, setMessageActions] = useState<LiveMessageActionContributionDto[]>([])
  const [messageActionPending, setMessageActionPending] = useState<string | null>(null)
  const [runtimeDisclosures, setRuntimeDisclosures] = useState<LiveRuntimeDisclosureContributionDto[]>([])
  const [runtimeActionPending, setRuntimeActionPending] = useState<string | null>(null)
  const [commands, setCommands] = useState<LiveCommandDto[]>([])
  const [modelControl, setModelControl] = useState<LiveModelControlDto | null>(null)
  const [thinking, setThinking] = useState<LiveThinkingControlDto | null>(null)
  const [extension, setExtension] = useState<LiveUiRequest | null>(null)
  const [extensionPending, setExtensionPending] = useState(false)
  const [streamingBehavior, setStreamingBehavior] = useState<LiveQueueMode>('steer')
  const [queue, setQueue] = useState<LiveQueueStateDto>(() => emptyLiveQueue())
  const [pendingQueue, setPendingQueue] = useState<PendingQueueSubmission[]>([])
  const [restoredQueue, setRestoredQueue] = useState<RestoredQueueDraft[]>([])
  const [queueMutationPending, setQueueMutationPending] = useState(false)
  const [connected, setConnected] = useState(false)
  const [activityStatus, setActivityStatus] = useState<'running' | 'compacting' | 'idle' | null>(null)
  const [bootstrapTarget, setBootstrapTarget] = useState<{ liveId: string; runtimeSessionId: string } | null>(null)
  const [syncError, setSyncError] = useState('')
  const [newRecords, setNewRecords] = useState(false)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [startupQueued, setStartupQueued] = useState<LiveMessageDto | null>(null)
  const [interruptNotice, setInterruptNotice] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pathError, setPathError] = useState('')
  const [composerHasContent, setComposerHasContent] = useState(false)
  const [composerAttachmentPending, setComposerAttachmentPending] = useState(false)
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [draft, setDraft] = useState<LiveMarkdownComposerDraft>({ revision: 0, value: '' })
  const composerRef = useRef<LiveMarkdownComposerHandle>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const historyLoadSentinelRef = useRef<HTMLDivElement>(null)
  const historyNewerSentinelRef = useRef<HTMLDivElement>(null)
  const lastReaderScrollTopRef = useRef(0)
  const historyAtLatestRef = useRef(true)
  const historyIndexAnchorCursorRef = useRef<string | undefined>(undefined)
  const historyBlocksRef = useRef<LiveHistoryPageBlock[]>([])
  const projectionRef = useRef(projection)
  projectionRef.current = projection
  const runtimeStateRef = useRef<LiveRuntimeStateDto | null>(state)
  runtimeStateRef.current = state
  const followControllerRef = useRef(new LiveFollowController())
  const followFrameRef = useRef<number | null>(null)
  const followReleaseFrameRef = useRef<number | null>(null)
  const startupSendingRef = useRef(false)
  const leafIdRef = useRef<string | undefined>(undefined)
  const snapshotBaseActiveCountRef = useRef(0)
  const liveTurnRevisionRef = useRef(0)
  const roundProjectorRef = useRef(new LiveTaskRoundProjector())
  const queueRevisionRef = useRef(0)


  return {
    product,
    setProduct,
    state,
    setState,
    projection,
    setProjection,
    historyPage,
    setHistoryPage,
    historyIndex,
    setHistoryIndex,
    historyLoading,
    setHistoryLoading,
    historyPagingArmed,
    setHistoryPagingArmed,
    historyPagingDirection,
    setHistoryPagingDirection,
    messageActions,
    setMessageActions,
    messageActionPending,
    setMessageActionPending,
    runtimeDisclosures,
    setRuntimeDisclosures,
    runtimeActionPending,
    setRuntimeActionPending,
    commands,
    setCommands,
    modelControl,
    setModelControl,
    thinking,
    setThinking,
    extension,
    setExtension,
    extensionPending,
    setExtensionPending,
    streamingBehavior,
    setStreamingBehavior,
    queue,
    setQueue,
    pendingQueue,
    setPendingQueue,
    restoredQueue,
    setRestoredQueue,
    queueMutationPending,
    setQueueMutationPending,
    connected,
    setConnected,
    activityStatus,
    setActivityStatus,
    bootstrapTarget,
    setBootstrapTarget,
    syncError,
    setSyncError,
    newRecords,
    setNewRecords,
    composerExpanded,
    setComposerExpanded,
    startupQueued,
    setStartupQueued,
    interruptNotice,
    setInterruptNotice,
    busy,
    setBusy,
    error,
    setError,
    pathError,
    setPathError,
    composerHasContent,
    setComposerHasContent,
    composerAttachmentPending,
    setComposerAttachmentPending,
    inputHistory,
    setInputHistory,
    draft,
    setDraft,
    composerRef,
    readerRef,
    historyLoadSentinelRef,
    historyNewerSentinelRef,
    lastReaderScrollTopRef,
    historyAtLatestRef,
    historyIndexAnchorCursorRef,
    historyBlocksRef,
    projectionRef,
    runtimeStateRef,
    followControllerRef,
    followFrameRef,
    followReleaseFrameRef,
    startupSendingRef,
    leafIdRef,
    snapshotBaseActiveCountRef,
    liveTurnRevisionRef,
    roundProjectorRef,
    queueRevisionRef,
  }
}

export type LiveTaskState = ReturnType<typeof useLiveTaskState>
