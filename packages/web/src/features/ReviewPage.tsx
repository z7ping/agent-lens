import { useEffect, useMemo, useRef, useState } from 'react'
import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'
import { AgentLogo } from '../components/AgentLogo'
import type { LiveMarkdownComposerDraft, LiveMarkdownComposerHandle } from '../components/LiveMarkdownComposer'
import { TaskSessionComposer } from '../components/TaskSessionComposer'
import { ImagePreview } from '../components/ImagePreview'
import { liveComposerDraftKey, readLiveComposerDraft } from '../components/live-composer-session-state'
import { LocalPathActions } from '../components/LocalPathActions'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { Button, Disclosure, IconButton, Input, SelectMenu, StatusBadge, Toolbar, UiIcon } from '../components/ui'
import { historyTaskPresentation, sessionListTitle } from './task-center'
import { projectReviewLiveInteraction } from './review-live-interaction'
import { TaskHeader } from './TaskHeader'
import { TaskSurface } from './TaskSurface'
import { readableTaskHeaderTitle, workspaceDisplayName } from './task-detail-model'
import { formatTime, formatDateTime, sessionRelativeTime, duration, compactTitle, hubSessionTime, hubSessionTitle } from './review-session-format'
import { Inspector } from './ReviewEvidenceInspector'
import { ReviewRoundAdapter, interactionStats } from './ReviewRoundPresentation'
import { TaskFileChangesDisclosure } from './TaskFileChangesDisclosure'
import { AgentLensApi } from '../client/api'
import type { AgentLensClientModel } from '../client/model'
import type { NativeRecordTextFragmentsResponseDto, ReviewInteractionDto } from '@agent-lens/protocol'
import { useReviewSession } from './use-review-session'
import { projectSelectOption } from './project-presentation'

type VerifiedRecordTextFragment = Extract<NativeRecordTextFragmentsResponseDto,
  {state:'available'}>['fragments'][number]
type OversizedFragmentState = {
  sessionId:string
  searchCursor?:string
  recordCursor?:string
  recordSha256?:string
  fragments:VerifiedRecordTextFragment[]
  images:Array<{contentIndex:number;mimeType:string}>
  imagesTruncated?:boolean
  mediaIndex?:number
  mediaDataUrl?:string
  totalTextFragments?:number
  nextFragmentOffset?:number
  toolLink?:{
    callKey:string;anchorOrdinal:number;loading:boolean
    scannedRecords:number;scanCursor?:string
    match?:{cursor:string;recordSha256:string
      fragments:VerifiedRecordTextFragment[];nextFragmentOffset?:number
      totalTextFragments:number}
    error?:string
  }
  locating:boolean
  loading:boolean
  error?:string
}

export function ReviewPage({ model, embedded = false, latestRequest = 0 }: { model: AgentLensClientModel; embedded?: boolean; latestRequest?: number }) {
  const {
    t,
    sessionId,
    navigate,
    inspect,
    setInspect,
    roundFilter,
    roundFilterLoading,
    showAllEvents,
    liveProducts,
    historyInteractionPending,
    historyInteractionError,
    historyInteractionBlocked,
    retryHistoryInteraction,
    pathError,
    setPathError,
    sessionLoadSentinelRef,
    detailLoadSentinelRef,
    readerPaneRef,
    roundExpansionRef,
    review,
    agents,
    projects,
    detail,
    detailLiveInteraction,
    visibleHubSessions,
    visibleNativeSessions,
    nativeHasMore,
    nativeLoadingMore,
    nativeBodySearchActive,
    nativeBodyPartial,
    nativeBodyError,
    loadMoreNativeSessions,
    sessionGroups,
    loadOlder,
    loadFollowing,
    select,
    selectRoundFilter,
    jumpToLatest,
    showFromStart,
    taskDetailModel,
    annotatedInteractions,
    turnRailItems,
    nativeTurnIndex,
    onTurnRailSelect,
    pageIncomplete,
    isBackward,
    isFiltered,
    atStart,
    onReaderScroll,
    emptyLabel,
    toggleEventVisibility,
    noteReaderUserIntent,
    sendReviewMessage,
    forkReviewAt
  } = useReviewSession(model, embedded)

  useEffect(() => {
    if (latestRequest > 0) void jumpToLatest()
  }, [latestRequest])

  const composerRef = useRef<LiveMarkdownComposerHandle>(null)
  const [composerExpanded, setComposerExpanded] = useState(false)
  const [composerHasContent, setComposerHasContent] = useState(false)
  const [attachmentPending, setAttachmentPending] = useState(false)
  const hookApi = useMemo(() => new AgentLensApi(), [])
  const hookRequestRef = useRef(0)
  const [oversized, setOversized] = useState<OversizedFragmentState|null>(null)
  const oversizedRevisionRef=useRef(0)
  const oversizedAbortRef=useRef<AbortController|null>(null)
  useEffect(()=>{
    oversizedAbortRef.current?.abort()
    oversizedRevisionRef.current++
    setOversized(null)
    return ()=>oversizedAbortRef.current?.abort()
  },[review.selectedId])
  const [hookEvidence, setHookEvidence] = useState<{
    sessionId: string
    interactions: ReviewInteractionDto[]
    nextCursor?: string
    hasMore: boolean
    loading: boolean
    error?: string
  } | null>(null)
  useEffect(() => {
    // Discard responses from the previous session, including slow native workers.
    hookRequestRef.current += 1
    setHookEvidence(null)
  }, [detail?.id])
  const loadHookEvidence = (cursor?: string) => {
    const id = detail?.id
    if (!id) return
    const requestId = ++hookRequestRef.current
    setHookEvidence(previous => ({
      sessionId: id,
      interactions: cursor && previous?.sessionId === id ? previous.interactions : [],
      hasMore: false,
      ...(cursor ? {nextCursor:cursor} : {}),
      loading: true,
    }))
    void hookApi.nativeReviewHooksById(id, cursor ? {cursor} : {}).then(page => {
      if (hookRequestRef.current !== requestId) return
      if (page.state !== 'available') {
        setHookEvidence(previous => ({
          sessionId: id,
          interactions: previous?.sessionId === id ? previous.interactions : [],
          hasMore: false,
          ...(cursor ? {nextCursor:cursor} : {}),
          loading: false,
          error: page.reason,
        }))
        return
      }
      if (page.boundaryIntegrity !== 'partial') {
        throw new Error('Hook-only evidence must not claim complete user turns')
      }
      if (page.hasMore && !page.nextCursor) {
        throw new Error('Hook pagination reported more files without a cursor')
      }
      setHookEvidence(previous => ({
        sessionId: id,
        interactions: [
          ...(cursor && previous?.sessionId === id ? previous.interactions : []),
          ...page.interactions,
        ],
        hasMore: page.hasMore,
        ...(page.hasMore && page.nextCursor ? {nextCursor:page.nextCursor} : {}),
        loading: false,
      }))
    }).catch(error => {
      if (hookRequestRef.current !== requestId) return
      setHookEvidence(previous => ({
        sessionId: id,
        interactions: previous?.sessionId === id ? previous.interactions : [],
        hasMore: false,
        ...(cursor ? {nextCursor:cursor} : {}),
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    })
  }
  const findOversizedRecord = async () => {
    const id=review.selectedId
    if(!id?.startsWith('native:')||oversized?.locating||oversized?.loading)return
    oversizedAbortRef.current?.abort()
    const controller=new AbortController()
    oversizedAbortRef.current=controller
    const revision=++oversizedRevisionRef.current
    const active=()=>!controller.signal.aborted
      &&oversizedRevisionRef.current===revision
    let searchCursor=oversized?.sessionId===id?oversized.searchCursor:undefined
    setOversized(previous=>({
      sessionId:id,fragments:previous?.sessionId===id?previous.fragments:[],
      images:[],...(searchCursor?{searchCursor}:{}),locating:true,loading:false,
    }))
    try{
      // Only explicit user action starts a finite search: max eight Source
      // windows, eight physical records each. Never full-scan at startup.
      for(let n=0;n<8;n++){
        const found=await hookApi.locateOversizedNativeRecord(id,{
          ...(searchCursor?{cursor:searchCursor}:{}),
          limit:8,signal:controller.signal,
        })
        if(!active())return
        if(found.state==='more'){
          if(!found.nextCursor||found.nextCursor===searchCursor)
            throw new Error('native-oversized-search-stalled')
          searchCursor=found.nextCursor
          continue
        }
        if(found.state==='found'){
          if(!found.hasText&&!found.hasMedia)
            throw new Error('native-oversized-record-no-visible-content')
          const page=await hookApi.nativeRecordTextFragments(id,{
            cursor:found.cursor,expectedSha256:found.recordSha256,
            fragmentOffset:0,limit:4,signal:controller.signal,
          })
          if(!active())return
          if(page.state!=='available')throw new Error(page.reason)
          if(page.coverage!=='fragment-only'
            ||page.recordSha256!==found.recordSha256
            ||page.fragments.some((piece,index)=>piece.ordinal!==index))
            throw new Error('native-fragment-evidence-mismatch')
          setOversized({sessionId:id,recordCursor:found.cursor,
            recordSha256:found.recordSha256,
            ...(found.nextCursor?{searchCursor:found.nextCursor}:{}),
            fragments:page.fragments,
            images:page.images??[],
            ...(page.imagesTruncated?{imagesTruncated:true}:{}),
            totalTextFragments:page.totalTextFragments,
            ...(page.nextFragmentOffset===undefined?{}:{
              nextFragmentOffset:page.nextFragmentOffset}),
            locating:false,loading:false})
          return
        }
        setOversized({sessionId:id,fragments:[],images:[],locating:false,loading:false,
          ...(found.state==='end'?{error:t('local.roundNav.nativeOversizedNotFound')}
          :{error:found.reason})})
        return
      }
      setOversized({sessionId:id,searchCursor,fragments:[],images:[],
        locating:false,loading:false})
    }catch(error){
      if(!active())return
      setOversized({sessionId:id,fragments:[],images:[],locating:false,loading:false,
        ...(searchCursor?{searchCursor}:{}),
        error:error instanceof Error?error.message:String(error)})
    }
  }

  const loadNextOversizedFragments = async () => {
    const current=oversized
    const id=review.selectedId
    if(!current||!id||current.sessionId!==id||!current.recordCursor
      ||!current.recordSha256||current.nextFragmentOffset===undefined
      ||current.loading||current.locating)return
    oversizedAbortRef.current?.abort()
    const controller=new AbortController()
    oversizedAbortRef.current=controller
    const revision=++oversizedRevisionRef.current
    const next=current.nextFragmentOffset
    setOversized({...current,loading:true,error:undefined})
    try{
      const page=await hookApi.nativeRecordTextFragments(id,{
        cursor:current.recordCursor,expectedSha256:current.recordSha256,
        fragmentOffset:next,limit:4,signal:controller.signal,
      })
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      if(page.state!=='available')throw new Error(page.reason)
      if(page.coverage!=='fragment-only'||page.recordSha256!==current.recordSha256
        ||page.totalTextFragments!==current.totalTextFragments
        ||!page.fragments.length
        ||page.fragments.some((piece,index)=>piece.ordinal!==next+index)
        ||(page.nextFragmentOffset!==undefined
          &&page.nextFragmentOffset<=next))
        throw new Error('native-fragment-evidence-mismatch')
      setOversized({...current,loading:false,
        fragments:[...current.fragments,...page.fragments].slice(-16),
        ...(page.nextFragmentOffset===undefined
          ?{nextFragmentOffset:undefined}
          :{nextFragmentOffset:page.nextFragmentOffset})})
    }catch(error){
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      setOversized({...current,loading:false,
        error:error instanceof Error?error.message:String(error)})
    }
  }

  const findLinkedToolResult = async (fragment:VerifiedRecordTextFragment) => {
    const current=oversized
    const id=review.selectedId
    if(!id||!current||current.sessionId!==id||!current.recordCursor
      ||!current.recordSha256||current.loading||current.locating
      ||current.toolLink?.loading||fragment.kind!=='tool-call'
      ||!fragment.callKey||fragment.suppressed)return
    oversizedAbortRef.current?.abort()
    const controller=new AbortController()
    oversizedAbortRef.current=controller
    const revision=++oversizedRevisionRef.current
    const earlier=current.toolLink?.callKey===fragment.callKey
      &&current.toolLink.anchorOrdinal===fragment.ordinal
      ?current.toolLink:undefined
    const priorScanned=earlier?.scannedRecords??0
    const scanCursor=earlier?.scanCursor
    setOversized({...current,toolLink:{
      callKey:fragment.callKey,anchorOrdinal:fragment.ordinal,
      loading:true,scannedRecords:priorScanned,
      ...(scanCursor?{scanCursor}:{}),
    }})
    try{
      const result=await hookApi.nativeRecordToolLink(id,{
        cursor:current.recordCursor,expectedSha256:current.recordSha256,
        fragmentOrdinal:fragment.ordinal,callKey:fragment.callKey,
        ...(scanCursor?{scanCursor}:{}),limit:4,signal:controller.signal,
      })
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      if(result.state!=='available')throw new Error(result.reason)
      if(result.coverage!=='tool-link-only'||result.sessionId!==id
        ||result.scannedRecords<0||result.scannedRecords>4
        ||(result.match&&result.nextCursor))
        throw new Error('native-tool-link-evidence-mismatch')
      let match:NonNullable<OversizedFragmentState['toolLink']>['match']|undefined
      if(result.match){
        const page=await hookApi.nativeRecordTextFragments(id,{
          cursor:result.match.cursor,expectedSha256:result.match.recordSha256,
          limit:4,signal:controller.signal,
        })
        if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
        if(page.state!=='available')throw new Error(page.reason)
        if(page.coverage!=='fragment-only'
          ||page.recordSha256!==result.match.recordSha256
          ||(page.role!=='tool'&&page.role!=='toolResult')
          ||page.fragments.some((item,index)=>item.ordinal!==index
            ||item.kind!=='tool-result'
            ||(item.callKey!==undefined&&item.callKey!==fragment.callKey)))
          throw new Error('native-tool-link-result-mismatch')
        match={cursor:result.match.cursor,recordSha256:result.match.recordSha256,
          fragments:page.fragments,totalTextFragments:page.totalTextFragments,
          ...(page.nextFragmentOffset===undefined?{}:{
            nextFragmentOffset:page.nextFragmentOffset}),
        }
      }
      setOversized(previous=>previous?.sessionId===id
        &&previous.recordSha256===current.recordSha256
        ?{...previous,toolLink:{
          callKey:fragment.callKey!,anchorOrdinal:fragment.ordinal,
          loading:false,scannedRecords:priorScanned+result.scannedRecords,
          ...(result.nextCursor?{scanCursor:result.nextCursor}:{}),
          ...(match?{match}:{}),
        }}:previous)
    }catch(error){
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      setOversized(previous=>previous?.sessionId===id
        &&previous.recordSha256===current.recordSha256
        ?{...previous,toolLink:{
          callKey:fragment.callKey!,anchorOrdinal:fragment.ordinal,
          loading:false,scannedRecords:priorScanned,
          ...(scanCursor?{scanCursor}:{}),
          error:error instanceof Error?error.message:String(error),
        }}:previous)
    }
  }

  const loadNextLinkedToolFragments = async () => {
    const current=oversized
    const id=review.selectedId
    const link=current?.toolLink
    const match=link?.match
    if(!id||!current||current.sessionId!==id||!link||!match
      ||match.nextFragmentOffset===undefined||link.loading
      ||current.loading||current.locating)return
    oversizedAbortRef.current?.abort()
    const controller=new AbortController()
    oversizedAbortRef.current=controller
    const revision=++oversizedRevisionRef.current
    const offset=match.nextFragmentOffset
    setOversized({...current,toolLink:{...link,loading:true}})
    try{
      const page=await hookApi.nativeRecordTextFragments(id,{
        cursor:match.cursor,expectedSha256:match.recordSha256,
        fragmentOffset:offset,limit:4,signal:controller.signal,
      })
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      if(page.state!=='available')throw new Error(page.reason)
      if(page.coverage!=='fragment-only'
        ||page.recordSha256!==match.recordSha256
        ||page.totalTextFragments!==match.totalTextFragments
        ||!page.fragments.length
        ||page.fragments.some((item,index)=>item.ordinal!==offset+index
          ||item.kind!=='tool-result'
          ||(item.callKey!==undefined&&item.callKey!==link.callKey))
        ||(page.nextFragmentOffset!==undefined
          &&page.nextFragmentOffset<=offset))
        throw new Error('native-tool-link-result-mismatch')
      setOversized(previous=>previous?.sessionId===id
        &&previous.recordSha256===current.recordSha256
        &&previous.toolLink?.match?.recordSha256===match.recordSha256
        &&previous.toolLink.callKey===link.callKey
        &&previous.toolLink.anchorOrdinal===link.anchorOrdinal
        ?{...previous,toolLink:{...link,loading:false,
          match:{...match,
            fragments:[...match.fragments,...page.fragments].slice(-16),
            nextFragmentOffset:page.nextFragmentOffset}}}:previous)
    }catch(error){
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      setOversized(previous=>previous?.sessionId===id
        &&previous.recordSha256===current.recordSha256
        &&previous.toolLink?.match?.recordSha256===match.recordSha256
        &&previous.toolLink.callKey===link.callKey
        &&previous.toolLink.anchorOrdinal===link.anchorOrdinal
        ?{...previous,toolLink:{...link,loading:false,
          error:error instanceof Error?error.message:String(error)}}:previous)
    }
  }

  const loadOversizedImage = async (image:{contentIndex:number;mimeType:string}) => {
    const current=oversized
    const id=review.selectedId
    if(!id||!current||current.sessionId!==id||!current.recordCursor
      ||!current.recordSha256||current.loading||current.locating
      ||!current.images.some(item=>item.contentIndex===image.contentIndex
        &&item.mimeType===image.mimeType))return
    oversizedAbortRef.current?.abort()
    const controller=new AbortController()
    oversizedAbortRef.current=controller
    const revision=++oversizedRevisionRef.current
    setOversized({...current,loading:true,mediaIndex:image.contentIndex,
      mediaDataUrl:undefined,error:undefined})
    try{
      const maxBase64=8*1024*1024
      let offset=0
      let base64=''
      let total=-1
      for(let n=0;n<64;n++){
        const page=await hookApi.nativeRecordMediaChunk(id,{
          cursor:current.recordCursor,expectedSha256:current.recordSha256,
          imageIndex:image.contentIndex,mediaOffset:offset,
          mediaLimit:128*1024,signal:controller.signal,
        })
        if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
        if(page.state!=='available')throw new Error(page.reason)
        if(page.coverage!=='media-chunk-only'
          ||page.recordSha256!==current.recordSha256
          ||page.contentIndex!==image.contentIndex
          ||page.mimeType!==image.mimeType
          ||page.base64.length<1||page.base64.length>128*1024
          ||(total>=0&&page.totalBase64Length!==total)
          ||page.totalBase64Length>maxBase64
          ||(page.nextOffset!==undefined&&page.nextOffset!==offset+page.base64.length))
          throw new Error('native-media-evidence-mismatch')
        total=page.totalBase64Length
        base64+=page.base64
        if(base64.length>maxBase64)throw new Error('native-media-preview-budget')
        if(page.nextOffset===undefined){
          if(base64.length!==total)
            throw new Error('native-media-incomplete')
          setOversized(previous=>previous?.sessionId===id
            &&previous.recordSha256===current.recordSha256
            ?{...previous,loading:false,mediaIndex:image.contentIndex,
              mediaDataUrl:`data:${image.mimeType};base64,${base64}`}
            :previous)
          return
        }
        if(page.nextOffset<=offset)throw new Error('native-media-cursor-stalled')
        offset=page.nextOffset
      }
      throw new Error('native-media-preview-budget')
    }catch(error){
      if(controller.signal.aborted||oversizedRevisionRef.current!==revision)return
      setOversized(previous=>previous?.sessionId===id
        &&previous.recordSha256===current.recordSha256
        ?{...previous,loading:false,error:error instanceof Error?error.message:String(error)}
        :previous)
    }
  }

  const draftKey = useMemo(() => detail && detailLiveInteraction
    ? liveComposerDraftKey(detailLiveInteraction.liveId, `history:${detail.id}`)
    : '', [detail?.id, detailLiveInteraction?.liveId])
  const composerDraft = useMemo<LiveMarkdownComposerDraft>(
    () => ({ revision: 0, value: draftKey ? readLiveComposerDraft(draftKey) : '' }), [draftKey],
  )
  useEffect(() => {
    setComposerHasContent(false)
    setAttachmentPending(false)
  }, [draftKey])
  const canCompose = Boolean(detailLiveInteraction?.canResume && detailLiveInteraction.canSend)

  return <main className={`review-page ${embedded ? 'review-page-embedded' : ''}`}>
    {!embedded && <Toolbar className="workspace-toolbar" aria-label={t('local.filters.toolbarAria')}>
      <AgentScope agents={agents} value={review.filters.sourceIds?.[0] ?? ''} onChange={sourceId => model.setReviewFilters({ sourceIds: sourceId ? [sourceId] : [] })}/>
      <span className="toolbar-divider" />
      <SelectMenu value={review.filters.projectId} onChange={projectId => model.setReviewFilters({ projectId })} ariaLabel={t('local.filters.projectAria')} placeholder={t('local.filters.allProjects')} searchable searchPlaceholder={t('local.filters.searchProject')} options={[
        { value: '', label: t('local.filters.allProjects') },
        ...projects.map(projectSelectOption),
      ]}/>
      <SelectMenu value={review.filters.range} onChange={range => model.setReviewFilters({ range: range as typeof review.filters.range })} ariaLabel={t('local.filters.timeAria')} options={[
        { value: 'today', label: t('local.filters.today') }, { value: '7d', label: t('local.filters.sevenDays') }, { value: '30d', label: t('local.filters.thirtyDays') }, { value: 'all', label: t('local.filters.allTime') },
      ]}/>
      <SelectMenu value={review.filters.status} onChange={status => model.setReviewFilters({ status: status as typeof review.filters.status })} ariaLabel={t('local.filters.statusAria')} options={[
        { value: 'all', label: t('local.filters.allStatus') }, { value: 'clean', label: t('local.filters.clean') }, { value: 'with-errors', label: t('local.filters.withErrors') },
      ]}/>
      <Input className="filter search-filter" placeholder={t('local.filters.searchPlaceholder')} value={review.filters.search} onChange={e => model.setReviewFilters({ search: e.target.value })}/>
      <IconButton onClick={() => void model.refreshReview()} title={t('local.filters.refresh')} aria-label={t('local.filters.refresh')}><UiIcon name="refresh" size={16}/></IconButton>
    </Toolbar>}

    <div className="review-layout">
      {!embedded && <aside className="session-panel">
        <div className="session-panel-head"><div><b>{t('local.list.sessions')}</b><span>{t('local.list.ordering')}</span></div><span className="count-badge">{(review.response?.items.length ?? 0) + visibleNativeSessions.length + visibleHubSessions.length}{review.response?.meta.hasMore || nativeHasMore ? '+' : ''}</span></div>
        <div className="session-scroll">
          {review.loading && !review.response && <div className="empty-state">{t('local.list.loading')}</div>}
          {sessionGroups.map(group => <section className="session-group-block" key={group.key}>
            <div className="session-group">{group.label}</div>
            {group.items.map(entry => entry.origin === 'local' ? (() => {
              const item = entry.local
              const presentation = historyTaskPresentation(
                item,
                item.projectName
                  ? t('local.session.projectSession', { project: item.projectName })
                  : t('local.session.agentSession', { agent: agentLabel(item.sourceIds[0] ?? '', item.productId) }),
              )
              const liveInteraction = projectReviewLiveInteraction(item, liveProducts)
              return <button key={`local:${item.id}`} className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`} onClick={() => select(item.id)}>
                <div className="session-item-title-row"><div className="session-item-title" title={presentation.title}>{sessionListTitle(presentation.title, t('local.session.agentSession', { agent: agentLabel(item.sourceIds[0] ?? '', item.productId) }), item.sourceIds)}</div>{liveInteraction?.canResume ? <StatusBadge tone="success">{t('local.session.resumable')}</StatusBadge> : presentation.activityLabel && <StatusBadge className="session-activity-badge">{presentation.activityLabel}</StatusBadge>}</div>
                <div className="session-item-meta"><span className={`source-dot ${sourceDot(item.sourceIds[0] ?? '')}`}/><span>{agentLabel(item.sourceIds[0] ?? '', item.productId)}</span><span className="session-item-project">{item.projectName ?? item.workspacePath?.split(/[\\/]/).pop() ?? t('local.session.noProject')}</span><time title={t('local.list.recentActivity', { time: formatTime(entry.activityAt) })}>{sessionRelativeTime(entry.activityAt)}</time></div>
              </button>
            })() : entry.origin === 'native' ? (() => {
              const item = entry.native
              const title = item.title?.trim() || t('local.session.agentSession', {
                agent: agentLabel(item.sourceId, item.sourceId),
              })
              return <button key={`native:${item.id}`}
                className={`session-item ${review.selectedId === item.id ? 'session-item-active' : ''}`}
                onClick={() => select(item.id)}>
                <div className="session-item-title-row">
                  <div className="session-item-title" title={title}>{title}</div>
                </div>
                <div className="session-item-meta">
                  <span className={`source-dot ${sourceDot(item.sourceId)}`}/>
                  <span>{agentLabel(item.sourceId, item.sourceId)}</span>
                  <span className="session-item-project">{item.projectName ?? t('local.session.nativeIndexed')}</span>
                  <time title={t('local.list.recentActivity', { time: formatTime(item.lastActivityAt) })}>
                    {sessionRelativeTime(item.lastActivityAt)}
                  </time>
                </div>
              </button>
            })() : (() => {
              const item = entry.remote
              const time = hubSessionTime(item)
              return <button key={`remote:${item.id}`} className="session-item" onClick={() => navigate(`/review/hub/${encodeURIComponent(item.id)}`)}>
                <div className="session-item-title-row"><div className="session-item-title" title={hubSessionTitle(item)}>{sessionListTitle(hubSessionTitle(item), t('local.session.remote'))}</div></div>
                <div className="session-item-meta"><span className="hub-session-source remote">{t('local.session.remoteSource', { node: item.origin.nodeId })}</span><time title={time || t('local.session.timeNotSynced')}>{time ? sessionRelativeTime(time) : t('local.session.timeNotSynced')}</time></div>
              </button>
            })())}
          </section>)}
          {review.response?.meta.hasMore && <button ref={sessionLoadSentinelRef} className="session-load-more" disabled={review.loadingMore} onClick={() => void model.loadMoreReview()}>{review.loadingMore ? t('local.list.loadMoreLoading') : review.error ? t('local.list.loadMoreFailed') : t('local.list.loadMoreAuto')}</button>}
          {nativeBodySearchActive && <div className="session-load-more" aria-live="polite">
            {nativeBodyError
              ? t('local.list.nativeBodySearchError', { reason: nativeBodyError })
              : nativeLoadingMore
                ? t('local.list.nativeBodySearchScanning')
                : nativeBodyPartial
                  ? t('local.list.nativeBodySearchPartial')
                  : t('local.list.nativeBodySearchComplete')}
          </div>}
          {nativeHasMore && <button className="session-load-more" disabled={nativeLoadingMore}
            onClick={() => void loadMoreNativeSessions()}>
            {nativeLoadingMore ? t('local.list.loadMoreLoading') : t('local.list.loadMoreNative')}
          </button>}
          {review.response && !review.response.meta.hasMore && !nativeHasMore
            && (review.response.items.length > 0 || visibleNativeSessions.length > 0)
            && <div className="session-load-more" aria-live="polite">{t('local.list.allLoaded')}</div>}
          {!review.loading && !review.response?.items.length && !visibleNativeSessions.length && !visibleHubSessions.length && <div className="empty-state">{t('local.list.empty')}</div>}
        </div>
      </aside>}

      <TaskSurface
        mode="review"
        className="review-session-view"
        boundaryNavigation={detail ? {
          startDisabled: roundFilterLoading || (detail.statisticsCompleteness==='window'
            ? detail.interactions[0]?.ordinal===1 : atStart),
          endDisabled: roundFilterLoading || (detail.statisticsCompleteness==='window'
            ? !(nativeTurnIndex?.state==='available' && nativeTurnIndex.coverage==='complete'
              && (detail.interactions.at(-1)?.ordinal??0) < (nativeTurnIndex.totalTurns??0))
            : false),
          onStart: showFromStart,
          onEnd: jumpToLatest,
        } : undefined}
        turnRailItems={detail ? turnRailItems : undefined}
        turnRailTotal={detail?.statisticsCompleteness==='window'
          && nativeTurnIndex?.state==='available' && nativeTurnIndex.coverage==='complete'
          ?nativeTurnIndex.totalTurns:undefined}
        turnRailKnownCount={detail?.statisticsCompleteness==='window'
          && nativeTurnIndex?.state==='available'
          ?nativeTurnIndex.knownTurns:undefined}
        onTurnRailSelect={onTurnRailSelect}
      >
        {detail && <TaskHeader
          marker={<AgentLogo sourceId={detail.productId || detail.sourceIds[0] || ''} size="normal"/>}
          agent={taskDetailModel?.agentLabel ?? ''}
          context={taskDetailModel?.projectLabel ?? workspaceDisplayName(taskDetailModel?.workspacePath) ?? t('local.session.unlinkedProject')}
          showStatus={false}
          title={<span title={readableTaskHeaderTitle(taskDetailModel?.title)}>{compactTitle(readableTaskHeaderTitle(taskDetailModel?.title))}</span>}
          metrics={[]}
          infoPanel={review.fileChanges && (review.fileChanges.summary.count > 0 || review.fileChanges.meta.truncated)
            ? {
                label: t('local.fileChanges.titleCount', { count: review.fileChanges.summary.count }),
                summary: t('local.fileChanges.titleCount', { count: review.fileChanges.summary.count }),
                content: <TaskFileChangesDisclosure value={review.fileChanges} inlineDetails/>,
              } : undefined}
          readingControls={<Toolbar className="round-nav" aria-label={t('local.roundNav.aria')}>
            <div className="round-nav-filters" aria-label={t('local.roundNav.filterAria')}>
              <Button className={roundFilter === 'all' && !isBackward ? 'active' : ''} aria-pressed={roundFilter === 'all' && !isBackward} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('all')}>{t('local.roundNav.all')}{roundFilter === 'all' && !isBackward && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
              <Button className={roundFilter === 'errors' ? 'active' : ''} aria-pressed={roundFilter === 'errors'} disabled={roundFilterLoading || detail.statisticsCompleteness === 'window'} onClick={() => void selectRoundFilter('errors')}>{t('local.roundNav.errors')}{roundFilter === 'errors' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
              <Button className={roundFilter === 'latency' ? 'active' : ''} aria-pressed={roundFilter === 'latency'} title={t('local.roundNav.latencyNote')} disabled={roundFilterLoading || detail.statisticsCompleteness === 'window'} onClick={() => void selectRoundFilter('latency')}>{t('local.roundNav.latency')}{roundFilter === 'latency' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
            </div>
            <div className="round-nav-actions" aria-label={t('local.roundNav.actionsAria')}>
              {review.detailHasNewData && <Button className="round-nav-live" onClick={() => void jumpToLatest()}>{t('local.roundNav.newRecords')}<UiIcon name="arrow-down" size={14}/></Button>}
              {detail?.statisticsCompleteness === 'window' && !detail.page.hasMore
                && <Button size="small" variant="quiet" disabled={review.detailLoadingMore}
                  onClick={() => void model.refreshReviewTailIncremental()}>
                  {t('local.roundNav.checkNativeTail')}
                </Button>}
            </div>
            {detail.statisticsCompleteness === 'window'
              && <span className="round-nav-status">{t('local.roundNav.nativeWindow')}</span>}
            {detail.statisticsCompleteness==='window' && nativeTurnIndex?.state==='available'
              && nativeTurnIndex.coverage==='partial'
              && <span className="round-nav-status" role="status">
                {t('local.roundNav.nativeIndexProgress',{count:nativeTurnIndex.knownTurns})}
              </span>}
            {detail.nativeTurnIncomplete
              && <span className="round-nav-status" role="status">{t(detail.page.hasMore ? 'local.roundNav.nativeTurnPartial' : 'local.roundNav.nativeTurnPendingTail')}</span>}
            {detail.nativeHookEventsTruncated
              && <span className="round-nav-status">{t('local.roundNav.nativeHookPartial')}</span>}
            {roundFilterLoading && <span className="round-nav-status">{t('local.roundNav.querying')}</span>}
          </Toolbar>}
          infoItems={taskDetailModel ? [
            ...(detail.statisticsCompleteness === 'window' ? [] : [
              { label: t('local.header.project'), value: taskDetailModel.projectLabel ?? t('local.session.unlinkedProject') },
            ]),
            ...(detail.statisticsCompleteness !== 'window' && taskDetailModel.startedAt && Number.isFinite(Date.parse(taskDetailModel.startedAt))
              ? [{ label: t('local.header.startTime'), value: formatDateTime(taskDetailModel.startedAt) }] : []),
            ...(detail.statisticsCompleteness !== 'window' && taskDetailModel.endedAt && Number.isFinite(Date.parse(taskDetailModel.endedAt))
              ? [{ label: t('local.header.endTime'), value: formatDateTime(taskDetailModel.endedAt) }] : []),
            ...(detail.statisticsCompleteness === 'window'
              ? [] : [{ label: t('local.header.duration'), value: duration(detail.durationMs) }]),
            ...(taskDetailModel.workspacePath ? [{
              label: t('local.header.workspace'),
              value: <span className="local-path-value">
                <code title={taskDetailModel.workspacePath}>{taskDetailModel.workspacePath}</code>
                <LocalPathActions
                  path={taskDetailModel.workspacePath}
                  onOpen={path => {
                    setPathError('')
                    return model.openHostPath(path)
                  }}
                  onError={reason => setPathError(reason instanceof Error ? reason.message : String(reason))}
                />
              </span>,
            }] : []),
            ...taskDetailModel.metrics.filter(metric => metric.label !== t('local.interaction.metricSpan')).map(metric => ({ label: metric.label, value: metric.value, tone: metric.tone })),
          ] : []}
          actions={<>
            {historyInteractionPending && <StatusBadge tone="accent" dot role="status">{t('local.header.preparingHistory')}</StatusBadge>}
            {historyInteractionBlocked ? <>
              <StatusBadge tone="warning" title={historyInteractionError}>{t('local.header.readOnlyObservation')}</StatusBadge>
              <Button size="small" variant="quiet" onClick={retryHistoryInteraction}>{t('local.header.retryConnection')}</Button>
            </> : historyInteractionError && <StatusBadge tone="danger" title={historyInteractionError}>{t('local.header.continueFailed', { error: historyInteractionError })}</StatusBadge>}
            <button className="review-audit-toggle" aria-pressed={showAllEvents} onClick={toggleEventVisibility}>{showAllEvents ? t('local.header.viewAll') : t('local.header.viewCore')}</button>
          </>}
        />}

        <div
          ref={readerPaneRef}
          className="review-reader-pane"
          data-review-session-id={detail?.id}
          onScroll={onReaderScroll}
          onWheelCapture={noteReaderUserIntent}
          onTouchStartCapture={noteReaderUserIntent}
          onPointerDownCapture={noteReaderUserIntent}
          onKeyDownCapture={noteReaderUserIntent}
        >
          {review.error && <div className="page-error">{review.error}</div>}
          {review.error&&review.selectedId?.startsWith('native:')
            &&review.error.includes('native-record-too-large')
            && <Disclosure
              summary={t('local.roundNav.nativeOversizedTitle')}
              summaryMeta={t('local.roundNav.nativeOversizedHint')}
            >
              {oversized?.sessionId===review.selectedId&&oversized.error
                && <div className="page-error" role="alert">{oversized.error}</div>}
              {oversized?.sessionId===review.selectedId
                && oversized.fragments.map(fragment=><div key={fragment.ordinal}>
                  <small>{t('local.roundNav.nativeOversizedPart',{count:fragment.ordinal+1})}
                    {' · '}
                    {fragment.kind==='thinking'?t('local.roundNav.nativeOversizedKindThinking')
                      :fragment.kind==='tool-call'?t('local.roundNav.nativeOversizedKindToolCall')
                      :fragment.kind==='tool-result'?t('local.roundNav.nativeOversizedKindToolResult')
                      :t('local.roundNav.nativeOversizedKindMessage')}
                    {fragment.suppressed? ` · ${t('local.roundNav.nativeOversizedRedacted')}`:''}
                  </small>
                  <pre className="review-oversized-fragment">{fragment.text}</pre>
                  {fragment.kind==='tool-call'&&fragment.callKey&&!fragment.suppressed
                    &&oversized.fragments.find(item=>item.kind==='tool-call'
                      &&item.callKey===fragment.callKey)?.ordinal===fragment.ordinal
                    &&<Button size="small"
                      disabled={Boolean(oversized.toolLink?.loading||oversized.loading)}
                      onClick={()=>void findLinkedToolResult(fragment)}>
                      {oversized.toolLink?.loading
                        &&oversized.toolLink.callKey===fragment.callKey
                        ?t('local.roundNav.querying')
                        :t('local.roundNav.nativeOversizedFindResult')}
                    </Button>}
                </div>)}
              {oversized?.sessionId===review.selectedId&&oversized.toolLink
                &&<div>
                  <small>{t('local.roundNav.nativeOversizedLinkedScan',{
                    count:oversized.toolLink.scannedRecords,
                  })}</small>
                  {oversized.toolLink.error&&<div className="page-error" role="alert">
                    {oversized.toolLink.error}</div>}
                  {oversized.toolLink.match
                    ?<>
                      <small>{t('local.roundNav.nativeOversizedLinkedVerified')}</small>
                      {oversized.toolLink.match.fragments.map(piece=>
                        <div key={piece.ordinal}>
                          <small>{t('local.roundNav.nativeOversizedPart',{
                            count:piece.ordinal+1,
                          })}</small>
                          <pre className="review-oversized-fragment">{piece.text}</pre>
                        </div>)}
                      {oversized.toolLink.match.nextFragmentOffset!==undefined
                        &&<Button size="small"
                          disabled={oversized.toolLink.loading}
                          onClick={()=>void loadNextLinkedToolFragments()}>
                          {oversized.toolLink.loading?t('local.roundNav.querying')
                            :t('local.roundNav.nativeOversizedLinkedMore')}
                        </Button>}
                    </>
                    :!oversized.toolLink.loading&&!oversized.toolLink.error
                      ?<small>{t('local.roundNav.nativeOversizedLinkedMissing')}</small>
                      :null}
                  {oversized.toolLink.scanCursor&&!oversized.toolLink.loading
                    &&!oversized.toolLink.match
                    &&oversized.fragments.some(piece=>piece.ordinal===oversized.toolLink!.anchorOrdinal)
                    &&<Button size="small"
                      onClick={()=>void findLinkedToolResult(
                        oversized.fragments.find(piece=>piece.ordinal===oversized.toolLink!.anchorOrdinal)!)}>
                      {t('local.roundNav.nativeOversizedFindResultMore')}
                    </Button>}
                </div>}
              {oversized?.sessionId===review.selectedId&&oversized.images.map(image=>
                <div key={image.contentIndex}>
                  <small>{t('local.roundNav.nativeOversizedImage',{count:image.contentIndex+1})}
                    {' · '}{image.mimeType}
                  </small>
                  {oversized.mediaIndex===image.contentIndex&&oversized.mediaDataUrl
                    ?<ImagePreview src={oversized.mediaDataUrl}
                      alt={t('local.roundNav.nativeOversizedImage',{count:image.contentIndex+1})}/>
                    :<Button size="small" disabled={oversized.loading||oversized.locating}
                      onClick={()=>void loadOversizedImage(image)}>
                      {oversized.loading&&oversized.mediaIndex===image.contentIndex
                        ?t('local.roundNav.querying')
                        :t('local.roundNav.nativeOversizedLoadImage')}
                    </Button>}
                </div>)}
              {oversized?.sessionId===review.selectedId&&oversized.imagesTruncated
                &&<small>{t('local.roundNav.nativeOversizedImagesTruncated')}</small>}
              {oversized?.sessionId===review.selectedId&&oversized.totalTextFragments!==undefined
                && <small>{t('local.roundNav.nativeOversizedProgress',{
                  visible:oversized.fragments.length,
                  total:oversized.totalTextFragments,
                })}</small>}
              {oversized?.sessionId===review.selectedId&&oversized.nextFragmentOffset!==undefined
                && <Button size="small" disabled={oversized.loading}
                  onClick={()=>void loadNextOversizedFragments()}>
                  {oversized.loading
                    ?t('local.roundNav.querying')
                    :t('local.roundNav.nativeOversizedMore')}
                </Button>}
              {(!oversized?.recordCursor||oversized.searchCursor)
                && <Button size="small"
                  disabled={Boolean(oversized?.locating||oversized?.loading)}
                  onClick={()=>void findOversizedRecord()}>
                  {oversized?.locating
                    ?t('local.roundNav.querying')
                    :oversized?.searchCursor
                      ?t('local.roundNav.nativeOversizedFindMore')
                      :t('local.roundNav.nativeOversizedFind')}
                </Button>}
            </Disclosure>}
          {pathError && <div className="page-error" role="alert">{pathError}</div>}
          {!detail ? <div className="empty-state fill">{review.selectedId && review.detailLoading ? t('local.empty.loadingDetail') : t('local.empty.selectSession')}</div> : <div className="review-reader">
            {historyInteractionError && !historyInteractionBlocked && <div className="page-error" role="alert">{historyInteractionError}</div>}

            {review.relationships?.items.length ? <details className="session-relationship-tree">
              <summary><UiIcon className="session-relationship-tree-chevron" name="chevron-right" size={14}/><span>{t('local.relationship.sessionTree', { count: review.relationships.items.length })}</span></summary>
              <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span><UiIcon name="arrow-right" size={14}/></span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
            </details> : null}

            {detail.statisticsCompleteness === 'window'
              && ['codex','claude-code','hermes'].includes(detail.sourceIds[0] ?? '')
              && <Disclosure
                summary={t('local.roundNav.nativeHookEvidence')}
                summaryMeta={t('local.roundNav.nativeHookEvidenceHint')}
                onToggle={event => {
                  if (event.currentTarget.open && hookEvidence?.sessionId !== detail.id) {
                    loadHookEvidence()
                  }
                }}
              >
                {hookEvidence?.sessionId === detail.id && hookEvidence.error
                  && <div className="page-error" role="alert">
                    {t('local.roundNav.nativeHookEvidenceLoadFailed', {reason:hookEvidence.error})}
                    <Button size="small" onClick={() => loadHookEvidence(hookEvidence.nextCursor)}>
                      {t('local.roundNav.loadFailedRetry')}
                    </Button>
                  </div>}
                {hookEvidence?.sessionId === detail.id && hookEvidence.interactions.map(interaction => {
                  const stats = interactionStats(interaction)
                  return <ReviewRoundAdapter
                    key={interaction.id}
                    sessionId={detail.id}
                    interaction={interaction}
                    round={{
                      id:interaction.id,
                      ordinal:interaction.ordinal,
                      label:t('local.interaction.background'),
                      state:'settled',
                      toolCount:stats.toolCount,
                      errorCount:stats.errorCount,
                      durationMs:stats.durationMs,
                      highLatency:false,
                    }}
                    inspect={setInspect}
                    loadAttachments={model.reviewAttachments}
                    loadProcess={model.reviewProcessDetail}
                    expansionStore={roundExpansionRef.current}
                    showAllEvents={showAllEvents}
                    onShowAllEvents={toggleEventVisibility}
                    fileChangesEnabled={false}
                  />
                })}
                {hookEvidence?.sessionId === detail.id && hookEvidence.hasMore
                  && <Button size="small" disabled={hookEvidence.loading}
                    onClick={() => loadHookEvidence(hookEvidence.nextCursor)}>
                    {t('local.roundNav.nativeHookEvidenceMore')}
                  </Button>}
                {hookEvidence?.sessionId === detail.id && hookEvidence.loading
                  && <div role="status">{t('local.roundNav.querying')}</div>}
                {hookEvidence?.sessionId === detail.id
                  && !hookEvidence.loading && !hookEvidence.hasMore
                  && !hookEvidence.interactions.length && !hookEvidence.error
                  && <div className="round-filter-empty">{t('local.roundNav.nativeHookEvidenceEmpty')}</div>}
              </Disclosure>}

            <div className="review-flow">
              {isBackward && roundFilter === 'all' && pageIncomplete && <div ref={detailLoadSentinelRef} className="detail-load-sentinel detail-load-sentinel-top" aria-live="polite">
                {review.detailLoadingMore
                  ? t('local.roundNav.loadingOlder')
                  : review.error
                    ? <button onClick={() => void loadOlder()}>{t('local.roundNav.loadFailedRetry')}</button>
                    : null}
              </div>}
              {annotatedInteractions.map((item, index) => <VirtualRoundMount
                key={item.round.id}
                eager={index < 6 || item.round.id === annotatedInteractions.at(-1)?.round.id}
                estimate={item.round.toolCount > 12 ? 420 : item.round.toolCount > 4 ? 300 : 220}
              >
                <ReviewRoundAdapter
                  sessionId={detail.id}
                  fileChangesEnabled={detail.statisticsCompleteness !== 'window' && (item.round.toolCount > 0
                     || item.interaction.nodes.some(node => node.type === 'event' && node.kind === 'artifact.action'))}
                  interaction={item.interaction}
                  round={item.round}
                  expansionStore={roundExpansionRef.current}
                  showAllEvents={showAllEvents}
                  onShowAllEvents={toggleEventVisibility}
                  inspect={setInspect}
                  loadAttachments={model.reviewAttachments}
                  loadProcess={model.reviewProcessDetail}
                  onForkAt={detailLiveInteraction?.canForkAt ? nativeEventId => { void forkReviewAt(nativeEventId) } : undefined}
                  forkPending={Boolean(historyInteractionPending)}
                />
              </VirtualRoundMount>)}
              {!annotatedInteractions.length && <div className="round-filter-empty">{emptyLabel}</div>}
              {!isBackward && roundFilter !== 'latest' && <div ref={detailLoadSentinelRef} className="detail-load-sentinel" aria-live="polite">
                {review.detailLoadingMore
                  ? t('local.roundNav.loadingFollowing', { scope: isFiltered ? t('local.roundNav.followingMatches') : t('local.roundNav.following') })
                  : detail.page.hasMore
                    ? review.error
                      ? <button onClick={() => void loadFollowing()}>{t('local.roundNav.loadFailedRetry')}</button>
                      : t('local.roundNav.autoLoadFollowing', { scope: isFiltered ? t('local.roundNav.followingMatches') : t('local.roundNav.following') })
                    : isFiltered
                      ? t('local.roundNav.allMatchesLoaded', { count: detail.interactions.length })
                      : t('local.roundNav.allLoaded', { count: detail.interactions.length })}
              </div>}
            </div>
          </div>}
        </div>
        {detail && canCompose && <div className="task-session-composer-slot">
          <TaskSessionComposer
            editorRef={composerRef}
            expanded={composerExpanded}
            onExpandedChange={setComposerExpanded}
            draft={composerDraft}
            draftKey={draftKey}
            onDraftPresenceChange={setComposerHasContent}
            canSubmit={!historyInteractionPending && !historyInteractionBlocked && !attachmentPending}
            onSubmit={message => { void sendReviewMessage(message) }}
            onEscape={undefined}
                        placeholder={t('task:live.composerPlaceholder')}
            ariaLabel={t('task:live.composerAria')}
            onAttachmentPendingChange={setAttachmentPending}
            onAttachmentError={reason => setPathError(reason instanceof Error ? reason.message : String(reason))}
            disabled={Boolean(historyInteractionPending || historyInteractionBlocked)}
            connectionLabel={historyInteractionBlocked ? t('local.header.readOnlyObservationHint') : t('local.header.resumeOnSend')}
            pendingConnection
            controlsReady={false}
            pendingModelControl={Boolean(detailLiveInteraction?.canModelControl)}
            pendingThinkingControl={Boolean(detailLiveInteraction?.canThinkingControl)}
            showStreamingModes={Boolean(detailLiveInteraction?.canStreamModes)}
            modesDisabled
            hasContent={composerHasContent}
            onSendClick={() => {
              const message = composerRef.current?.getMessage()
              if (message) void sendReviewMessage(message)
            }}
          />
        </div>}
      </TaskSurface>
    </div>
    {inspect && <Inspector key={inspect.id} node={inspect} loadSourceRecords={model.sourceRecords} onClose={() => setInspect(null)}/>} 
  </main>
}
