import { AgentScope, agentLabel, sourceDot } from '../components/AgentScope'
import { LocalPathActions } from '../components/LocalPathActions'
import { VirtualRoundMount } from '../components/VirtualRoundMount'
import { Button, IconButton, Input, SelectMenu, StatusBadge, Toolbar, UiIcon } from '../components/ui'
import { historyTaskPresentation, sessionListTitle } from './task-center'
import { projectReviewLiveInteraction } from './review-live-interaction'
import { TaskFileChangesDisclosure } from './TaskFileChangesDisclosure'
import { TaskHeader } from './TaskHeader'
import { TaskSurface } from './TaskSurface'
import { workspaceDisplayName } from './task-detail-model'
import { formatTime, formatDateTime, sessionRelativeTime, duration, compactTitle, hubSessionTime, hubSessionTitle } from './review-session-format'
import { Inspector } from './ReviewEvidenceInspector'
import { ReviewRoundAdapter } from './ReviewRoundPresentation'
import type { AgentLensClientModel } from '../client/model'
import { useReviewSession } from './use-review-session'

export function ReviewPage({ model, embedded = false }: { model: AgentLensClientModel; embedded?: boolean }) {
  const {
    t,
    sessionId,
    navigate,
    inspect,
    setInspect,
    roundFilter,
    roundFilterLoading,
    expandAllRounds,
    roundExpansionRevision,
    showAllEvents,
    liveProducts,
    historyInteractionPending,
    historyInteractionError,
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
    pageIncomplete,
    isBackward,
    isFiltered,
    atStart,
    onReaderScroll,
    emptyLabel,
    toggleRoundExpansion,
    toggleEventVisibility,
    noteReaderUserIntent,
    runHistoryInteraction
  } = useReviewSession(model, embedded)

  return <main className={`review-page ${embedded ? 'review-page-embedded' : ''}`}>
    {!embedded && <Toolbar className="workspace-toolbar" aria-label={t('local.filters.toolbarAria')}>
      <AgentScope agents={agents} value={review.filters.sourceIds?.[0] ?? ''} onChange={sourceId => model.setReviewFilters({ sourceIds: sourceId ? [sourceId] : [] })}/>
      <span className="toolbar-divider" />
      <SelectMenu value={review.filters.projectId} onChange={projectId => model.setReviewFilters({ projectId })} ariaLabel={t('local.filters.projectAria')} placeholder={t('local.filters.allProjects')} searchable searchPlaceholder={t('local.filters.searchProject')} options={[
        { value: '', label: t('local.filters.allProjects') },
        ...projects.map(project => ({ value: project.id, label: project.name ?? project.repositoryIdentity ?? project.id, description: project.repositoryIdentity ?? undefined })),
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
        <div className="session-panel-head"><div><b>{t('local.list.sessions')}</b><span>{t('local.list.ordering')}</span></div><span className="count-badge">{(review.response?.items.length ?? 0) + visibleHubSessions.length}{review.response?.meta.hasMore ? '+' : ''}</span></div>
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
          {review.response && !review.response.meta.hasMore && review.response.items.length > 0 && <div className="session-load-more" aria-live="polite">{t('local.list.allLoaded')}</div>}
          {!review.loading && !review.response?.items.length && !visibleHubSessions.length && <div className="empty-state">{t('local.list.empty')}</div>}
        </div>
      </aside>}

      <TaskSurface
        mode="review"
        className="review-session-view"
        boundaryNavigation={detail ? {
          startDisabled: roundFilterLoading || atStart,
          endDisabled: roundFilterLoading,
          onStart: showFromStart,
          onEnd: jumpToLatest,
        } : undefined}
        turnRailItems={detail ? turnRailItems : undefined}
      >
        {detail && <TaskHeader
          marker={<span className={`source-dot ${sourceDot(detail.sourceIds[0] ?? '')}`}/>}
          agent={taskDetailModel?.agentLabel ?? ''}
          context={taskDetailModel?.projectLabel ?? workspaceDisplayName(taskDetailModel?.workspacePath) ?? t('local.session.unlinkedProject')}
          showStatus={false}
          title={<span title={taskDetailModel?.title}>{compactTitle(taskDetailModel?.title, 15)}</span>}
          metrics={[]}
          viewActions={<Button role="menuitem" disabled={roundFilterLoading} onClick={toggleRoundExpansion}>{expandAllRounds ? t('local.roundNav.collapsePage') : t('local.roundNav.expandPage')}</Button>}
          readingControls={<Toolbar className="round-nav" aria-label={t('local.roundNav.aria')}>
            <div className="round-nav-filters" aria-label={t('local.roundNav.filterAria')}>
              <Button className={roundFilter === 'all' && !isBackward ? 'active' : ''} aria-pressed={roundFilter === 'all' && !isBackward} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('all')}>{t('local.roundNav.all')}{roundFilter === 'all' && !isBackward && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
              <Button className={roundFilter === 'errors' ? 'active' : ''} aria-pressed={roundFilter === 'errors'} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('errors')}>{t('local.roundNav.errors')}{roundFilter === 'errors' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
              <Button className={roundFilter === 'latency' ? 'active' : ''} aria-pressed={roundFilter === 'latency'} title={t('local.roundNav.latencyNote')} disabled={roundFilterLoading} onClick={() => void selectRoundFilter('latency')}>{t('local.roundNav.latency')}{roundFilter === 'latency' && <span>{annotatedInteractions.length}{pageIncomplete ? '+' : ''}</span>}</Button>
            </div>
            <div className="round-nav-actions" aria-label={t('local.roundNav.actionsAria')}>
              {review.detailHasNewData && <Button className="round-nav-live" onClick={() => void jumpToLatest()}>{t('local.roundNav.newRecords')}<UiIcon name="arrow-down" size={14}/></Button>}
            </div>
            {roundFilterLoading && <span className="round-nav-status">{t('local.roundNav.querying')}</span>}
          </Toolbar>}
          infoItems={taskDetailModel ? [
            { label: t('local.header.project'), value: taskDetailModel.projectLabel ?? t('local.session.unlinkedProject') },
            ...(taskDetailModel.startedAt && Number.isFinite(Date.parse(taskDetailModel.startedAt))
              ? [{ label: t('local.header.startTime'), value: formatDateTime(taskDetailModel.startedAt) }] : []),
            ...(taskDetailModel.endedAt && Number.isFinite(Date.parse(taskDetailModel.endedAt))
              ? [{ label: t('local.header.endTime'), value: formatDateTime(taskDetailModel.endedAt) }] : []),
            { label: t('local.header.duration'), value: duration(detail.durationMs) },
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
            {historyInteractionError && <StatusBadge tone="danger" title={historyInteractionError}>{t('local.header.continueFailed', { error: historyInteractionError })}</StatusBadge>}
            <button className="review-audit-toggle" aria-pressed={showAllEvents} onClick={toggleEventVisibility}>{showAllEvents ? t('local.header.viewAll') : t('local.header.viewCore')}</button>
          </>}
          continuationActions={<>
            {detailLiveInteraction?.canResume && <Button size="small" loading={historyInteractionPending === 'resume'} disabled={Boolean(historyInteractionPending)} onClick={() => void runHistoryInteraction('resume')}><UiIcon name="arrow-right" size={14}/>{t('local.header.continueSession')}</Button>}
            {detailLiveInteraction?.canFork && <Button size="small" loading={historyInteractionPending === 'fork'} disabled={Boolean(historyInteractionPending)} onClick={() => void runHistoryInteraction('fork')}><UiIcon name="plus" size={14}/>{t('local.header.forkContinue')}</Button>}
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
          {pathError && <div className="page-error" role="alert">{pathError}</div>}
          {!detail ? <div className="empty-state fill">{review.selectedId && review.detailLoading ? t('local.empty.loadingDetail') : t('local.empty.selectSession')}</div> : <div className="review-reader">
            {historyInteractionError && <div className="page-error" role="alert">{historyInteractionError}</div>}

            {review.relationships?.items.length ? <details className="session-relationship-tree">
              <summary><UiIcon className="session-relationship-tree-chevron" name="chevron-right" size={14}/><span>{t('local.relationship.sessionTree', { count: review.relationships.items.length })}</span></summary>
              <div>{review.relationships.items.map(item => <div key={item.id}>{item.fromNativeSessionId ?? item.fromSessionId} <span><UiIcon name="arrow-right" size={14}/></span> {item.toNativeSessionId ?? item.toSessionId}</div>)}</div>
            </details> : null}

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
                  fileChangesEnabled={Boolean(review.fileChanges?.summary.count) && detail.interactionCount > 1}
                  interaction={item.interaction}
                  round={item.round}
                  defaultExpanded={expandAllRounds}
                  expansionStore={roundExpansionRef.current}
                  forceExpanded={expandAllRounds}
                  forceRevision={roundExpansionRevision}
                  showAllEvents={showAllEvents}
                  onShowAllEvents={toggleEventVisibility}
                  inspect={setInspect}
                  loadAttachments={model.reviewAttachments}
                  loadProcess={model.reviewProcessDetail}
                />
              </VirtualRoundMount>)}
              <TaskFileChangesDisclosure value={review.fileChanges} loading={review.fileChangesLoading} error={review.fileChangesError}/>
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
      </TaskSurface>
    </div>
    {inspect && <Inspector node={inspect} loadSourceRecords={model.sourceRecords} onClose={() => setInspect(null)}/>} 
  </main>
}
