import { useState, type ReactNode } from 'react'
import { copyText } from '../client/clipboard'
import { UiIcon } from './UiIcon'
import { Button } from './ui'

export function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await copyText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }
  return <span className="state-command"><code>{command}</code><button onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button></span>
}

export function EmptyStatePanel({
  icon,
  title,
  description,
  action,
  children,
  compact = false,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: { label: string; onClick(): void }
  children?: ReactNode
  compact?: boolean
}) {
  const renderedIcon = icon === '⌕' ? <UiIcon name="search" size={20}/> : icon
  return <div className={`state-empty ${compact ? 'is-compact' : ''}`}>
    <div className="state-empty-icon" aria-hidden="true">{renderedIcon}</div>
    <h3>{title}</h3>
    <p>{description}</p>
    {(action || children) && <div className="state-actions">
      {action && <Button variant="primary" onClick={action.onClick}>{action.label}</Button>}
      {children}
    </div>}
  </div>
}

export function ErrorStateBanner({
  message,
  onRetry,
  retryLabel = '重试',
  showDoctor = true,
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
  showDoctor?: boolean
}) {
  return <div className="state-error" role="alert">
    <div className="state-error-copy"><b>加载失败</b><span>{message}</span></div>
    <div className="state-error-actions">
      {onRetry && <Button variant="primary" onClick={onRetry}>{retryLabel}</Button>}
      {showDoctor && <CommandRow command="agent-lens doctor"/>}
    </div>
  </div>
}

function SkeletonLine({ width = '100%', height = 11 }: { width?: string; height?: number }) {
  return <span className="state-skeleton" style={{ width, height }}/>
}

export function SessionListSkeleton() {
  return <div className="session-list-skeleton" aria-label="正在加载会话">
    {[0, 1, 2, 3].map(index => <div className="session-skeleton-card" key={index}>
      <div className="state-skeleton-row"><span className="state-skeleton state-skeleton-dot"/><SkeletonLine width={index % 2 ? '66px' : '58px'}/><SkeletonLine width="48px"/></div>
      <SkeletonLine width={index % 2 ? '76%' : '84%'} height={13}/>
      <SkeletonLine width={index % 2 ? '52%' : '61%'}/>
    </div>)}
  </div>
}

export function ReviewDetailSkeleton() {
  return <div className="review-detail-skeleton" aria-label="正在加载会话详情">
    <SkeletonLine width="42%" height={19}/>
    <SkeletonLine width="30%"/>
    <div className="review-detail-skeleton-metrics">
      {[0, 1, 2, 3].map(index => <span className="state-skeleton" key={index}/>) }
    </div>
    <span className="state-skeleton review-detail-skeleton-message"/>
    <span className="state-skeleton review-detail-skeleton-flow"/>
    <span className="state-skeleton review-detail-skeleton-message short"/>
  </div>
}

export function WorkspaceSkeleton({ kind = 'cards' }: { kind?: 'cards' | 'table' }) {
  return <div className={`workspace-skeleton workspace-skeleton-${kind}`} aria-label="正在加载页面数据">
    <SkeletonLine width="112px" height={20}/>
    <SkeletonLine width="48%"/>
    {kind === 'table' ? <>
      <div className="workspace-skeleton-kpis">{[0, 1, 2, 3].map(index => <span key={index} className="state-skeleton"/>)}</div>
      <div className="workspace-skeleton-table">
        {[0, 1, 2, 3, 4].map(index => <span key={index} className="state-skeleton"/>) }
      </div>
    </> : <div className="workspace-skeleton-cards">{[0, 1].map(index => <span key={index} className="state-skeleton"/>)}</div>}
  </div>
}

export function PageLoadingState({
  eyebrow = '正在处理',
  statusLabel = '进行中',
  title,
  description,
  facts = [],
}: {
  eyebrow?: string
  statusLabel?: string
  title: string
  description: string
  facts?: string[]
}) {
  return <div className="page-loading-state" role="status" aria-live="polite" aria-label={title}>
    <section className="page-loading-card">
      <div className="page-loading-main">
        <div className="page-loading-icon" aria-hidden="true"><UiIcon name="refresh" size={20}/></div>
        <div className="page-loading-copy">
          <div className="page-loading-kicker">
            <span className="eyebrow">{eyebrow}</span>
            <span className="page-loading-badge"><i/>{statusLabel}</span>
          </div>
          <h2>{title}</h2>
          <p>{description}</p>
          {facts.length > 0 && <div className="page-loading-facts">
            {facts.map(fact => <span key={fact}><UiIcon name="check" size={13}/>{fact}</span>)}
          </div>}
        </div>
      </div>
      <div className="page-loading-progress" aria-hidden="true"><i/></div>
      <div className="page-loading-preview" aria-hidden="true">
        {[0, 1, 2].map(index => <div className="page-loading-preview-card" key={index}>
          <SkeletonLine width={index === 0 ? '42%' : index === 1 ? '34%' : '38%'}/>
          <SkeletonLine width={index === 0 ? '64%' : index === 1 ? '52%' : '58%'} height={21}/>
          <SkeletonLine width={index === 0 ? '76%' : index === 1 ? '68%' : '72%'}/>
        </div>)}
      </div>
    </section>
  </div>
}

export function FirstRunGuide({
  detectedCount,
  enabledCount,
  serviceReady,
  liveConnected,
}: {
  detectedCount: number
  enabledCount: number
  serviceReady: boolean
  liveConnected: boolean
}) {
  const captureReady = enabledCount > 0 && serviceReady && liveConnected
  return <section className="first-run-guide" aria-label="首次运行引导">
    <div className="first-run-heading"><span className="eyebrow">开始使用</span><h2>完成这三步，就可以开始复盘</h2><p>引导只使用 AgentLens 当前能够确认的事实：检测结果、采集开关、后台状态和实时连接；不会把“未观察到”推断成“未安装”。</p></div>
    <div className="first-run-steps">
      <div className={`first-run-step ${detectedCount > 0 ? 'is-done' : 'is-pending'}`}>
        <span className="first-run-no">{detectedCount > 0 ? <UiIcon name="check" size={14}/> : '1'}</span>
        <div><b>检测智能体</b><p>{detectedCount > 0 ? `已检测到 ${detectedCount} 个受支持的智能体。` : '暂未检测到受支持的智能体；可运行诊断命令确认本机检测路径。'}</p></div>
      </div>
      <div className={`first-run-step ${captureReady ? 'is-done' : 'is-pending'}`}>
        <span className="first-run-no">{captureReady ? <UiIcon name="check" size={14}/> : '2'}</span>
        <div><b>启用采集并确认运行</b><p>{enabledCount > 0 ? `当前有 ${enabledCount} 个来源已允许采集；${serviceReady ? (liveConnected ? '后台服务和实时数据通道均正常。' : '后台服务正常，实时数据通道暂未连接。') : '后台服务当前不可用或处于降级状态。'}` : '当前没有来源允许采集；请先按采集隐私策略启用需要观察的来源。'}</p></div>
      </div>
      <div className="first-run-step is-pending">
        <span className="first-run-no">3</span>
        <div><b>产生一条可复盘会话</b><p>在已启用采集的智能体里开始一次任务。首条会话进入 AgentLens 后，这张引导会自动消失。</p></div>
      </div>
    </div>
    {(!detectedCount || !captureReady) && <div className="first-run-footer"><span>需要确认安装、运行或采集状态时：</span><CommandRow command="agent-lens doctor"/></div>}
  </section>
}
