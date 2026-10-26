import { isAbsolute } from 'node:path'
import type {
  AgentInstallation,
  Host,
  NativeSessionCatalogStore,
  RuntimeProfile,
  SourceCheckpointService,
  SourceDefinition,
  SourceHistoryWindow,
} from '@agent-lens/core'

const DEFAULT_SESSION_BUDGET = 32
const MAX_SESSION_BUDGET = 128

export type NativeCatalogFailure =
  | 'invalid-discovery'
  | 'unavailable'
  | 'drifted'
  | 'unsupported'
  | 'empty-session'
  | 'record-identity-drifted'
  | 'recovery-unverified'
  | 'source-read-error'

export interface NativeCatalogScanReport {
  sourceId: string
  installationId: string
  /** Hook lifecycle gaps do not authorize a second copy of the transcript. */
  nativeCoverage: 'certified' | 'partial'
  scanned: number
  indexed: number
  failures: Partial<Record<NativeCatalogFailure, number>>
  /** Hitting a scan budget is not proof that discovery reached EOF. */
  exhausted: boolean
}

export interface NativeCatalogScanInput {
  source: SourceDefinition
  host: Host
  installation: AgentInstallation
  runtimeProfile?: RuntimeProfile
  signal: AbortSignal
  historyWindow?: SourceHistoryWindow
  /** Maximum original Source sessions inspected in this foreground slice. */
  maxSessions?: number
  onProgress?: (report: NativeCatalogScanReport) => void | Promise<void>
}

const readonlyCheckpoint: SourceCheckpointService = {
  async get() { return null },
  async set() { throw new Error('Native catalog indexing cannot persist ingestion checkpoints') },
  async clear() { throw new Error('Native catalog indexing cannot clear ingestion checkpoints') },
}

/** Native-only scan: no Legacy ownership arbitration, no ingestion replay,
 * no SourceRecord/Observation/Evidence writer. The source adapter owns the
 * original root/path authorization, and recovery verification is mandatory.
 *
 * Does NOT declare the entire installation migrated: coverage gaps, Hook
 * archives, existing legacy-only sessions and follow-up pages need separate
 * cutover accounting. It may be used for both new and partially migrated DBs.
 */
export class NativeOnlySourceIndexer {
  constructor(
    private readonly catalog: Pick<NativeSessionCatalogStore, 'upsert'>,
  ) {}

  async scan(input: NativeCatalogScanInput): Promise<NativeCatalogScanReport> {
    const { source, host, installation, runtimeProfile, signal } = input
    const maxSessions = input.maxSessions ?? DEFAULT_SESSION_BUDGET
    if (!Number.isSafeInteger(maxSessions)
      || maxSessions < 1 || maxSessions > MAX_SESSION_BUDGET) {
      throw new RangeError('Native catalog scan budget must be between 1 and 128')
    }
    if (source.manifest.sourceId !== installation.productId
      && !source.manifest.sourceId.trim()) {
      throw new Error('Native catalog Source identity is missing')
    }
    if (!installation.id || installation.hostId !== host.id
      || installation.productId !== source.manifest.productId) {
      throw new Error('Native catalog installation identity changed')
    }
    if (runtimeProfile && runtimeProfile.installationId !== installation.id) {
      throw new Error('Native catalog profile belongs to another installation')
    }
    if (!source.discoverNativeSessions || !source.readNativeSessionPage
      || !source.rawRecovery?.verify) {
      throw new Error('Source does not support verified native session discovery')
    }
    const budget = Math.min(maxSessions, input.historyWindow?.sessionLimit ?? maxSessions)
    if (!Number.isSafeInteger(budget) || budget < 1) {
      throw new RangeError('Native catalog history window session limit must be positive')
    }
    const report: NativeCatalogScanReport = {
      sourceId: source.manifest.sourceId,
      installationId: installation.id,
      nativeCoverage: source.nativeSessionCoverageComplete === true ? 'certified' : 'partial',
      scanned: 0,
      indexed: 0,
      failures: {},
      exhausted: false,
    }
    const failure = (reason: NativeCatalogFailure) => {
      report.failures[reason] = (report.failures[reason] ?? 0) + 1
    }
    const context = {
      host,
      installation,
      ...(runtimeProfile ? { runtimeProfile } : {}),
      abortSignal: signal,
      checkpoint: readonlyCheckpoint,
    }
    let hitBudget = false
    const discovered = source.discoverNativeSessions({
      ...context,
      historyWindow: {
        ...(input.historyWindow?.activeSince
          ? { activeSince: input.historyWindow.activeSince }
          : {}),
        sessionLimit: budget,
      },
    })
    for await (const entry of discovered) {
      signal.throwIfAborted()
      if (report.scanned >= budget) {
        hitBudget = true
        break
      }
      report.scanned++
      if (entry.sourceId !== source.manifest.sourceId
        || entry.installationId !== installation.id
        || entry.locationKind !== 'native'
        || !entry.nativeSessionId?.trim()
        || !isAbsolute(entry.filePath)
        || !entry.fileIdentity?.trim()
        || !Number.isSafeInteger(entry.fileSize) || entry.fileSize < 0
        || !Number.isFinite(entry.fileMtimeMs)) {
        failure('invalid-discovery')
        continue
      }
      try {
        // The first Source-owned record and its revision must match discovery
        // BEFORE any metadata becomes eligible for Review/Usage/Insights.
        const page = await source.readNativeSessionPage({
          filePath: entry.filePath,
          nativeSessionId: entry.nativeSessionId,
          limit: 1,
        }, context)
        signal.throwIfAborted()
        if (page.state !== 'available') {
          failure(page.state)
          continue
        }
        if (page.nextCursor.fileIdentity !== entry.fileIdentity) {
          failure('drifted')
          continue
        }
        if (!page.records.length) {
          failure('empty-session')
          continue
        }
        const first = page.records[0]!
        if (page.records.length !== 1
          || first.sourceId !== entry.sourceId
          || first.installationId !== entry.installationId
          || first.sourceSessionNativeId !== entry.nativeSessionId
          || first.locator.path !== entry.filePath
          || !first.fingerprint) {
          failure('record-identity-drifted')
          continue
        }
        const verification = await source.rawRecovery.verify(first, context)
        signal.throwIfAborted()
        if (verification.state !== 'verified') {
          failure('recovery-unverified')
          continue
        }
        await this.catalog.upsert(entry)
        report.indexed++
      } catch (error) {
        if (signal.aborted) throw error
        // Do not expose raw original paths or payloads in operational reports.
        failure('source-read-error')
      }
      if (input.onProgress) await input.onProgress({ ...report, failures: { ...report.failures } })
      if ((report.scanned & 7) === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    report.exhausted = !hitBudget && report.scanned < budget
    return report
  }
}
