import { useState } from 'react'

export function BackgroundDataNotice({
  label,
  hasSseBanner,
  onRefresh,
}: {
  label: string
  hasSseBanner: boolean
  onRefresh(): Promise<void> | void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }

  return <div className={`background-data-notice ${hasSseBanner ? 'has-sse-banner' : ''}`} role="status">
    <span className="background-data-dot" aria-hidden="true"/>
    <span>{label}有新数据</span>
    <button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? '刷新中…' : '刷新查看'}</button>
  </div>
}
