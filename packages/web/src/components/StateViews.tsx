import { useState, type ReactNode } from 'react'
import { copyText } from '../client/clipboard'

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
  icon: string
  title: string
  description: string
  action?: { label: string; onClick(): void }
  children?: ReactNode
  compact?: boolean
}) {
  return <div className={`state-empty ${compact ? 'is-compact' : ''}`}>
    <div className="state-empty-icon" aria-hidden="true">{icon}</div>
    <h3>{title}</h3>
    <p>{description}</p>
    {(action || children) && <div className="state-actions">
      {action && <button className="state-button state-button-primary" onClick={action.onClick}>{action.label}</button>}
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
      {onRetry && <button className="state-button state-button-primary" onClick={onRetry}>{retryLabel}</button>}
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

export function FirstRunGuide({
  detectedCount,
  serviceReady,
  liveConnected,
}: {
  detectedCount: number
  serviceReady: boolean
  liveConnected: boolean
}) {
  const runtimeReady = serviceReady && liveConnected
  return <section className="first-run-guide" aria-label="首次运行引导">
    <div className="first-run-heading"><span className="eyebrow">开始使用</span><h2>完成这三步，就可以开始复盘</h2><p>这里只使用 AgentLens 当前能够确认的状态，不把“未观察到”推断成“未安装”。</p></div>
    <div className="first-run-steps">
      <div className={`first-run-step ${detectedCount > 0 ? 'is-done' : 'is-pending'}`}>
        <span className="first-run-no">{detectedCount > 0 ? '✓' : '1'}</span>
        <div><b>检测智能体</b><p>{detectedCount > 0 ? `已检测到 ${detectedCount} 个受支持的智能体。` : '尚未检测到 Codex、Claude Code 或 Pi。'}</p></div>
      </div>
      <div className={`first-run-step ${runtimeReady ? 'is-done' : 'is-pending'}`}>
        <span className="first-run-no">{runtimeReady ? '✓' : '2'}</span>
        <div><b>确认 AgentLens 运行状态</b><p>{serviceReady ? (liveConnected ? '后台服务正常，实时数据通道已连接。' : '后台服务正常，但实时数据通道当前未连接。') : '后台服务当前不可用或处于降级状态。'}</p></div>
      </div>
      <div className="first-run-step is-pending">
        <span className="first-run-no">3</span>
        <div><b>产生一条可复盘会话</b><p>开始一次智能体任务。会话进入 AgentLens 后，这张引导卡会自动消失。</p></div>
      </div>
    </div>
    {(!detectedCount || !runtimeReady) && <div className="first-run-footer"><span>需要排查时可运行：</span><CommandRow command="agent-lens doctor"/></div>}
  </section>
}
