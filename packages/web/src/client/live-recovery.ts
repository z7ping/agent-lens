import { LIVE_RECONNECTED_EVENT } from './api'
import type { AgentLensClientModel } from './model'

const RECOVERY_DEBOUNCE_MS = 180

/**
 * EventSource 会自动重连，但断线窗口中的服务端事件不会被回放。
 * 重连后只做一次低频快照校准，任务复盘保留当前详情阅读上下文；
 * 这是连接恢复路径，不参与正常高频 SSE 更新。
 */
export function installLiveRecovery(model: AgentLensClientModel): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const recover = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void Promise.allSettled([
        model.refreshReview({ preserveDetail: true }),
        model.refreshFacetsAndAgents(),
        model.refreshUsage(),
      ])
    }, RECOVERY_DEBOUNCE_MS)
  }

  window.addEventListener(LIVE_RECONNECTED_EVENT, recover)
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    window.removeEventListener(LIVE_RECONNECTED_EVENT, recover)
  }
}
