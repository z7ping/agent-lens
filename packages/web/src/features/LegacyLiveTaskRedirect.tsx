import { Navigate, useParams } from 'react-router-dom'

/**
 * Compatibility for URLs created before Live Product Surface carried liveId.
 * Those one-segment URLs were created only by the Pi compatibility surface.
 * New product code must always use /review/live/:liveId/:runtimeSessionId.
 */
export function LegacyLiveTaskRedirect() {
  const { runtimeSessionId = '' } = useParams()
  return <Navigate to={`/review/live/pi/${encodeURIComponent(runtimeSessionId)}`} replace />
}
