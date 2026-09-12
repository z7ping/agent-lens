import { useState } from 'react'
import { useTranslation } from 'react-i18next'

export function BackgroundDataNotice({
  label,
  hasSseBanner,
  onRefresh,
}: {
  label: string
  hasSseBanner: boolean
  onRefresh(): Promise<void> | void
}) {
  const { t } = useTranslation('common')
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
    <span>{t('newDataFor', { label })}</span>
    <button disabled={refreshing} onClick={() => void refresh()}>{refreshing ? t('refreshInProgress') : t('refreshToView')}</button>
  </div>
}
