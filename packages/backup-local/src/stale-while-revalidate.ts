import type {
  BackupCreateInput,
  BackupOverview,
  BackupProtectionSource,
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
  /** 用户配置的智能体顺序；冷索引和后台刷新都按此顺序逐个完成。 */
  sourceOrder?: string[]
  accessStaleMs?: number
  safetyRefreshMs?: number
}

/**
 * 备份索引属于可重建 Projection，不应该阻塞页面首屏。
 *
 * - 没有索引：先只读本地缓存；真正扫描按用户配置的智能体顺序逐个执行。
 * - 每完成一个 Source 就立即更新 current，Web 轮询可以渐进展示已完成结果。
 * - 有旧索引：立即返回旧数据，后台按相同顺序重验证，不清空可用结果。
 * - 定时器只做低频安全兜底；实时会话/Agent Web 不依赖这个扫描。
 */
export class StaleWhileRevalidateBackupService implements BackupService {
  private current: BackupOverview | null = null
  private loadInFlight: Promise<void> | null = null
  private refreshInFlight: Promise<void> | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private readonly accessStaleMs: number
  private readonly safetyRefreshMs: number
  private readonly sourceOrder: readonly string[]
  private readonly sourceOrderIndex: ReadonlyMap<string, number>

  constructor(
    private readonly base: BackupService,
    private readonly options: StaleWhileRevalidateBackupOptions,
  ) {
    this.accessStaleMs = options.accessStaleMs ?? DEFAULT_ACCESS_STALE_MS
    this.safetyRefreshMs = options.safetyRefreshMs ?? DEFAULT_SAFETY_REFRESH_MS
    this.sourceOrder = [...new Set((options.sourceOrder ?? []).map(item => item.trim()).filter(Boolean))]
    this.sourceOrderIndex = new Map(this.sourceOrder.map((sourceId, index) => [sourceId, index]))
  }

  start(): void {
    // 启动时只尝试读取已持久化索引，不主动与历史同步争抢磁盘。
    void this.ensureLoaded()
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

  private present(overview: BackupOverview, refreshing: boolean, staleOverride?: boolean): BackupOverview {
    const stale = staleOverride ?? this.indexAge(overview) >= this.accessStaleMs
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

  private compareSources(left: BackupProtectionSource, right: BackupProtectionSource): number {
    const leftRank = this.sourceOrderIndex.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER
    const rightRank = this.sourceOrderIndex.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER
    if (leftRank !== rightRank) return leftRank - rightRank
    return left.sourceId.localeCompare(right.sourceId)
  }

  private mergeSourceOverview(sourceId: string, next: BackupOverview): BackupOverview {
    const previousSources = this.current?.sources ?? []
    const nextSourceIds = new Set(next.sources.map(source => source.sourceId))
    const sources = [
      ...previousSources.filter(source => source.sourceId !== sourceId && !nextSourceIds.has(source.sourceId)),
      ...next.sources,
    ].sort((left, right) => this.compareSources(left, right))
    return this.present({
      ...next,
      sources,
      snapshots: next.snapshots.length ? next.snapshots : (this.current?.snapshots ?? []),
    }, true, true)
  }

  private ensureLoaded(): Promise<void> {
    if (this.current) return Promise.resolve()
    if (this.loadInFlight) return this.loadInFlight

    // 新接口保证这里只做本地 inventory 读取；没有缓存时绝不触发第三方目录扫描。
    const load = this.base.peekOverview
      ? this.base.peekOverview()
      : Promise.resolve(null)
    const promise = load.then(overview => {
      if (overview) this.current = this.present(overview, false)
    }).catch(() => {
      // 首次缓存读取失败不阻塞页面；访问时仍可重新建立索引。
    }).finally(() => {
      if (this.loadInFlight === promise) this.loadInFlight = null
    })
    this.loadInFlight = promise
    return promise
  }

  private beginRefresh(): void {
    if (this.refreshInFlight) return

    const promise = (async () => {
      let failed = false
      if (!this.sourceOrder.length) {
        try {
          const overview = this.base.refreshIndex
            ? await this.base.refreshIndex()
            : await this.base.overview()
          this.current = this.present(overview, false, false)
        } catch {
          failed = true
        }
      } else {
        for (const sourceId of this.sourceOrder) {
          try {
            const input = { sourceIds: [sourceId] }
            const overview = this.base.refreshIndex
              ? await this.base.refreshIndex(input)
              : await this.base.overview(input)
            this.current = this.mergeSourceOverview(sourceId, overview)
          } catch {
            // 单个智能体失败不能阻止后续智能体继续加载。
            failed = true
          }
        }
      }

      if (this.current) {
        this.current = this.present(this.current, false, failed)
      }
    })().finally(() => {
      if (this.refreshInFlight === promise) this.refreshInFlight = null
    })
    this.refreshInFlight = promise
  }

  async overview(input: BackupCreateInput = {}): Promise<BackupOverview> {
    // 过滤读取仍直接委托，避免把过滤逻辑复制成第二套事实解释。
    if (input.sourceIds?.length || input.kinds?.length) return this.base.overview(input)

    await this.ensureLoaded()
    if (!this.current) {
      this.beginRefresh()
      return this.placeholder(true)
    }

    if (this.indexAge(this.current) >= this.accessStaleMs) this.beginRefresh()
    return this.present(this.current, Boolean(this.refreshInFlight))
  }

  async peekOverview(input: BackupCreateInput = {}): Promise<BackupOverview | null> {
    if (input.sourceIds?.length || input.kinds?.length) {
      return this.base.peekOverview ? this.base.peekOverview(input) : null
    }
    await this.ensureLoaded()
    return this.current ? this.present(this.current, Boolean(this.refreshInFlight)) : null
  }

  async refreshIndex(input: BackupCreateInput = {}): Promise<BackupOverview> {
    if (input.sourceIds?.length || input.kinds?.length) {
      return this.base.refreshIndex ? this.base.refreshIndex(input) : this.base.overview(input)
    }
    await this.ensureLoaded()
    this.beginRefresh()
    return this.current
      ? this.present(this.current, true, true)
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
