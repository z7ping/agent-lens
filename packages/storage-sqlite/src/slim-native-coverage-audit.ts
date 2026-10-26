import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { assertSlimSchema } from './slim-schema'

export interface SlimNativeCoverageAudit {
  /** Catalog identity alone is NOT evidence the entire native session is intact. */
  readonly nativeContentFullyVerified: false
  readonly readyToSwitch: false
  readonly oldSessionIdentities: number
  readonly migratedContextIdentities: number
  readonly nativeIndexed: number
  readonly archivedOnly: number
  readonly missingFromNativeCatalog: number
  readonly missingContext: number
  readonly invalidOldIdentities: number
  /** SourceRecord facts without a native session identity are invisible to Catalog coverage. */
  readonly legacyRecordsWithoutSession: number
  readonly nativeMetricsMissingOrStale: number
  /** Rows marked partial can never certify full numerical replay. */
  readonly nativeMetricsPartial: number
  /** Existing Hook records require original Hook archives, not a Session Catalog row. */
  readonly legacyHookRecords: number
  /** Opaque digest; no user prompts, raw file paths or session IDs. */
  readonly missingExamples: readonly {sourceId:string;opaqueSession:string}[]
  readonly nextRequiredActions: readonly string[]
}

function count(db:Database.Database, sql:string):number {
  const value=db.prepare(sql).get() as {n:number}
  return value.n
}

/** Compares the old v38 identity graph to a rebuilt, slim-only catalog.
 * Both handles MUST be read-only, and neither original transcripts nor
 * persisted SQL events are materialized by this audit.
 *
 * IMPORTANT: Passing here does NOT prove readable contents or permit cutover.
 * Source Reader still must attest full original replay per session, with
 * Hook gaps reported separately.
 */
export function auditSlimNativeCoverage(
  oldDb:Database.Database,
  slimDb:Database.Database,
):SlimNativeCoverageAudit {
  if(!oldDb.readonly || !slimDb.readonly) {
    throw new Error('Native coverage audit requires read-only old and slim databases')
  }
  assertSlimSchema(slimDb)
  const oldVersion=oldDb.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number|null}
  if(oldVersion.v!==38) throw new Error('Native coverage audit requires v38 legacy schema')
  const missingExamples:Array<{sourceId:string;opaqueSession:string}>=[]
  const native=slimDb.prepare(`SELECT 1 FROM native_session_catalog WHERE
    source_id=? AND installation_id=? AND native_session_id=? AND location_kind='native'
    LIMIT 1`)
  const archive=slimDb.prepare(`SELECT 1 FROM native_session_catalog WHERE
    source_id=? AND installation_id=? AND native_session_id=? AND location_kind='archive'
    LIMIT 1`)
  const context=slimDb.prepare(`SELECT 1 FROM native_session_context WHERE
    source_id=? AND installation_id=? AND native_session_id=? LIMIT 1`)
  const identities=oldDb.prepare(`SELECT DISTINCT source_id,installation_id,native_session_id
    FROM source_sessions`)
  let oldSessionIdentities=0,invalidOldIdentities=0,nativeIndexed=0
  let archivedOnly=0,missingFromNativeCatalog=0,missingContext=0
  for(const row of identities.iterate() as Iterable<{
    source_id:string|null;installation_id:string|null;native_session_id:string|null
  }>) {
    oldSessionIdentities++
    const {source_id,installation_id,native_session_id}=row
    if(!source_id || !installation_id || !native_session_id) {
      invalidOldIdentities++
      continue
    }
    const args=[source_id,installation_id,native_session_id] as const
    if(!context.get(...args)) missingContext++
    if(native.get(...args)) {
      nativeIndexed++
    } else if(archive.get(...args)) {
      archivedOnly++
    } else {
      missingFromNativeCatalog++
      if(missingExamples.length<32) {
        missingExamples.push({
          sourceId:source_id,
          opaqueSession:createHash('sha256')
            .update(JSON.stringify(args)).digest('hex').slice(0,20),
        })
      }
    }
  }
  // v38 may contain Hook/SourceRecords without a source_sessions identity.
  // Session Catalog coverage alone must never certify these old-only facts.
  // Query identifiers and counts only; legacy payload_json is not materialized.
  const hasSourceRecords=Boolean(oldDb.prepare(`SELECT 1 FROM sqlite_master
    WHERE type='table' AND name='source_records'`).get())
  const legacyRecordsWithoutSession=hasSourceRecords?count(oldDb,`
    SELECT COUNT(*) AS n FROM source_records AS r
    WHERE r.source_session_native_id IS NULL
      OR TRIM(r.source_session_native_id) = ''
      OR NOT EXISTS (
        SELECT 1 FROM source_sessions AS s
        WHERE s.source_id=r.source_id
          AND s.installation_id=r.installation_id
          AND s.native_session_id=r.source_session_native_id
      )
  `):0
  // Count only metadata for legacy Hook facts. Never materialize source payloads.
  // Old databases without the optional columns cannot be taken as proof of
  // zero Hooks; the final source capability gate remains required regardless.
  const sourceColumns=hasSourceRecords
    ?(oldDb.prepare('PRAGMA table_info("source_records")').all() as Array<{name:string}>).map(x=>x.name)
    :[]
  const legacyHookRecords=hasSourceRecords && sourceColumns.includes('locator_json')
    ?count(oldDb,`SELECT COUNT(*) AS n FROM source_records
      WHERE ${sourceColumns.includes('native_type')?"LOWER(COALESCE(native_type,'')) LIKE '%hook%' OR":''}
        (CASE WHEN json_valid(locator_json) THEN
          json_extract(locator_json,'$.kind')='runtime-hook' ELSE 0 END)`)
    :0
  const migratedContextIdentities=count(slimDb,'SELECT COUNT(*) AS n FROM native_session_context')
  const nativeMetricsMissingOrStale=count(slimDb,`
    SELECT COUNT(*) AS n FROM native_session_catalog AS c
    LEFT JOIN native_session_metrics AS m
      ON m.source_id=c.source_id AND m.installation_id=c.installation_id
      AND m.native_session_id=c.native_session_id
    WHERE c.location_kind='native' AND (
      m.source_id IS NULL
      OR m.file_identity<>c.file_identity
      OR m.file_size<>c.file_size
      OR m.file_mtime_ms<>c.file_mtime_ms
    )`)
  const nativeMetricsPartial=count(slimDb,`SELECT COUNT(*) AS n
    FROM native_session_catalog AS c
    JOIN native_session_metrics AS m ON m.source_id=c.source_id
      AND m.installation_id=c.installation_id AND m.native_session_id=c.native_session_id
    WHERE c.location_kind='native' AND m.coverage<>'complete'`)
  return {
    nativeContentFullyVerified:false,
    readyToSwitch:false,
    oldSessionIdentities,
    migratedContextIdentities,
    nativeIndexed,
    archivedOnly,
    missingFromNativeCatalog,
    missingContext,
    invalidOldIdentities,
    legacyRecordsWithoutSession,
    nativeMetricsMissingOrStale,nativeMetricsPartial,legacyHookRecords,
    missingExamples,
    nextRequiredActions:[
      'Use Source-owned readers to verify the entire original session, not only the first record',
      'Rebuild missing Catalog and numerical metrics with the Native-only indexer and bounded readers',
      'Report old-only transcripts, unmapped SourceRecords and Hook partial coverage without copying event bodies',
      'Validate settings, backup identity and all business consumers before freezing old writers',
      'Freeze, reconcile and atomically cut over only after cross-source acceptance',
    ],
  }
}
