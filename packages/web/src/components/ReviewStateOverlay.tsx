import type { AgentLensClientModel, ClientSnapshot } from '../client/model'
import { EmptyStatePanel, ErrorStateBanner, FirstRunGuide, ReviewDetailSkeleton, SessionListSkeleton } from './StateViews'

function broadReviewFilters(review: ClientSnapshot['review']): boolean {
  return !review.filters.sourceId
    && !review.filters.projectId
    && !review.filters.search
    && review.filters.status === 'all'
    && review.filters.range === 'all'
}

export function ReviewStateOverlay({ model, snapshot }: { model: AgentLensClientModel; snapshot: ClientSnapshot }) {
  const review = snapshot.review
  const response = review.response
  const detectedCount = snapshot.agents?.items.filter(agent => agent.detected).length ?? 0
  const serviceReady = snapshot.health?.status === 'ok' && snapshot.health.storage.ok
  const hasSseBanner = Boolean(snapshot.health && !snapshot.liveConnected)
  const shellClass = `review-state-overlay ${hasSseBanner ? 'has-sse-banner' : ''}`

  if (review.loading && !response) {
    return <div className={`${shellClass} is-loading`} aria-live="polite">
      <aside className="review-state-session"><SessionListSkeleton/></aside>
      <section className="review-state-reader"><ReviewDetailSkeleton/></section>
    </div>
  }

  if (review.error && !response) {
    return <div className={`${shellClass} is-blocking`}>
      <div className="review-state-blocking-inner">
        <ErrorStateBanner message={review.error} onRetry={() => void model.refreshReview()}/>
      </div>
    </div>
  }

  if (response && response.items.length === 0) {
    const broad = broadReviewFilters(review)
    return <div className={`${shellClass} is-blocking`}>
      <div className="review-state-blocking-inner">
        {broad ? <FirstRunGuide detectedCount={detectedCount} serviceReady={serviceReady} liveConnected={snapshot.liveConnected}/>
          : <EmptyStatePanel
            icon="⌕"
            title="没有匹配的会话"
            description="当前筛选范围没有会话。可以先放宽时间、项目、智能体或状态筛选，再继续查找。"
            action={{
              label: '放宽筛选条件',
              onClick: () => model.setReviewFilters({ sourceId: '', projectId: '', range: 'all', status: 'all', search: '' }),
            }}
          />}
      </div>
    </div>
  }

  if (review.selectedId && review.detailLoading && !review.detail) {
    return <div className={`${shellClass} is-detail-loading`} aria-live="polite">
      <section className="review-state-reader"><ReviewDetailSkeleton/></section>
    </div>
  }

  if (review.error) {
    return <div className={`review-state-floating-error ${hasSseBanner ? 'has-sse-banner' : ''}`}>
      <ErrorStateBanner
        message={review.error}
        retryLabel={review.selectedId ? '重试当前会话' : '重试'}
        onRetry={() => void (review.selectedId ? model.selectReviewSession(review.selectedId) : model.refreshReview())}
      />
    </div>
  }

  return null
}
