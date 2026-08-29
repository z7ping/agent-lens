import type {
  BackupCreateInput,
  BackupOverview,
  BackupRestorePreview,
  BackupService,
  BackupSnapshotManifest,
  BackupSnapshotSummary,
  BackupVerifyResult,
} from '@agent-lens/core'

const DEFAULT_ACCESS_STALE_MS = 5 * 60 * 1000
const DEFAULT_SAFETY_REFRESH_MS = 30 * 60 * 1000
const EMPTY_INDEX_TIME = new Date(0).toISOString()

export interface StaleWhileRevalidateBackupOptions {
  vaultPath: string
  accessStaleMs?: number
  safetyRefreshMs?: number
}

/**
 * 备份索引属于可重建 Projection，不应该阻塞页面首屏。
 *
 * - 没有索引：立即返回“未就绪”，后台生成首份索引。
 * - 有旧索引：立即返回旧数据，超过阈值时后台重建。
 * - 定时器只做低频安全兜底；实时会话/Agent Web 不依赖这个全量扫描。
 */
export class StaleWhileRevalidateBackupService implements BackupService {
  private current: BackupOverview | null = null
  private loadInFlight: Promise<void> | null = null
  private refreshInFlight: Promise<void> | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly accessStaleMs: number
  private readonly safetyRefreshMs: number

  constructor(
    private readonly base: BackupService,
    private readonly options: StaleWhileRevalidateBackupOptions,
  ) {
    this.accessStaleMs = options.accessStaleMs ?? DEFAULT_ACCESS_STALE_MS
    this.safetyRefreshMs = options.safetyRefreshMs ?? DEFAULT_SAFETY_REFRESH_MS
  }

  start(): void {
    this.ensureLoaded()
    if (this.refreshTimer || this.safetyRefreshMs <= 0) return
    this.refreshTimer = setInterval(() => this.beginRefresh(), this.safetyRefreshMs)
    this.refreshTimer.unref()
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = null
  }

  private placeholder(refreshing = true): BackupOverview {
    return {
      vaultPath: this.options.vaultPath,
      sources: [],
      snapshots: [],
      index: {
        generatedAt: EMPTY_INDEX_TIME,
        refreshing,
        ready: false,
        stale: true,
      },
    }
  }

  private indexAge(overview: BackupOverview): number {
    const generatedAt = overview.index?.generatedAt
    if (!generatedAt) return Number.POSITIVE_INFINITY
    const timestamp = Date.parse(generatedAt)
    return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY
  }

  private present(overview: BackupOverview, refreshing: boolean): BackupOverview {
    const stale = this.indexAge(overview) >= this.accessStaleMs
    return {
      ...overview,
      index: {
        generatedAt: overview.index?.generatedAt ?? new Date().toISOString(),
        refreshing,
        ready: true,
        stale,
      },
    }
  }

  private ensureLoaded(): void {
    if (this.current || this.loadInFlight) return
    const promise = this.base.overview().then(overview => {
      this.current = this.present(overview, false)
      if (this.indexAge(overview) >= this.accessStaleMs) this.beginRefresh()
    }).catch(() => {
      // 页面轮询会再次触发；首次扫描失败不允许把 API 永久挂起。
    }).finally(() => {
      if (this.loadInFlight === promise) this.loadInFlight = null
    })
    this.loadInFlight = promise
  }

  private beginRefresh(): void {
    if (this.refreshInFlight) return
    const refresh = this.base.refreshIndex
      ? () => this.base.refreshIndex!()
      : () => this.base.overview()
    const promise = refresh().then(overview => {
      this.current = this.present(overview, false)
    }).catch(() => {
      // 保留旧索引；下一次显式刷新或过期检查可再次尝试。
    }).finally(() => {
      if (this.refreshInFlight === promise) this.refreshInFlight = null
    })
    this.refreshInFlight = promise
  }

  async overview(input: BackupCreateInput = {}): Promise<BackupOverview> {
    // 当前 Web 只读取完整 overview。过滤读取仍直接委托，避免把过滤逻辑复制成第二套事实解释。
    if (input.sourceIds?.length || input.kinds?.length) return this.base.overview(input)

    this.ensureLoaded()
    if (!this.current) return this.placeholder(true)

    if (this.indexAge(this.current) >= this.accessStaleMs) this.beginRefresh()
    return this.present(this.current, Boolean(this.refreshInFlight || this.loadInFlight))
  }

  async refreshIndex(input: BackupCreateInput = {}): Promise<BackupOverview> {
    if (input.sourceIds?.length || input.kinds?.length) {
      return this.base.refreshIndex ? this.base.refreshIndex(input) : this.base.overview(input)
    }
    this.ensureLoaded()
    this.beginRefresh()
    return this.current
      ? this.present(this.current, true)
      : this.placeholder(true)
  }

  listSnapshots(): Promise<BackupSnapshotSummary[]> { return this.base.listSnapshots() }
  getSnapshot(id: string): Promise<BackupSnapshotManifest | null> { return this.base.getSnapshot(id) }
  createSnapshot(input: BackupCreateInput = {}): Promise<BackupSnapshotManifest> { return this.base.createSnapshot(input) }
  verifySnapshot(id: string): Promise<BackupVerifyResult> { return this.base.verifySnapshot(id) }
  exportSnapshot(id: string): Promise<Uint8Array> { return this.base.exportSnapshot(id) }
  importSnapshot(bundle: Uint8Array): Promise<BackupSnapshotManifest> { return this.base.importSnapshot(bundle) }
  previewRestore(id: string): Promise<BackupRestorePreview> { return this.base.previewRestore(id) }
}
