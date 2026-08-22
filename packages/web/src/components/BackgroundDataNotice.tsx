export function BackgroundDataNotice({
  label,
  loading,
  hasSseBanner,
  onRefresh,
}: {
  label: string
  loading: boolean
  hasSseBanner: boolean
  onRefresh(): void
}) {
  return <div className={`background-data-notice ${hasSseBanner ? 'has-sse-banner' : ''}`} role="status">
    <span className="background-data-dot" aria-hidden="true"/>
    <span>{label}有新数据</span>
    <button disabled={loading} onClick={onRefresh}>{loading ? '刷新中…' : '刷新查看'}</button>
  </div>
}
