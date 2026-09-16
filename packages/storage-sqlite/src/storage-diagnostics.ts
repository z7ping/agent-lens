import type Database from 'better-sqlite3'

type StorageRow = Record<string, unknown>

function rowRecord(value: unknown): StorageRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite storage diagnostic query returned a non-object row')
  }
  return value as StorageRow
}

function requiredNumber(row: StorageRow, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`SQLite storage diagnostic field ${key} must be a finite number`)
  }
  return value
}

function optionalString(row: StorageRow, key: string): string | null {
  const value = row[key]
  if (value == null) return null
  if (typeof value !== 'string') {
    throw new TypeError(`SQLite storage diagnostic field ${key} must be a string or null`)
  }
  return value
}

type StorageCategoryName =
  | 'canonical'
  | 'evidence'
  | 'sourceRaw'
  | 'projection'
  | 'replication'
  | 'operational'

const CANONICAL_TABLES = new Set([
  'hosts',
  'agent_products',
  'agent_installations',
  'runtime_profiles',
  'projects',
  'workspaces',
  'logical_sessions',
  'source_sessions',
  'session_relationships',
  'agent_actors',
  'interactions',
  'observations',
  'asset_definitions',
  'asset_bindings',
  'asset_state_observations',
  'tool_definitions',
])
const EVIDENCE_TABLES = new Set(['evidence', 'observation_evidence', 'coverage'])
const PROJECTION_TABLES = new Set([
  'session_summary_projection',
  'unknown_observation_projection',
  'tool_usage_fact_projection',
])

function storageCategoryForTable(tableName: string): StorageCategoryName {
  if (tableName === 'source_records') return 'sourceRaw'
  if (CANONICAL_TABLES.has(tableName)) return 'canonical'
  if (EVIDENCE_TABLES.has(tableName)) return 'evidence'
  if (PROJECTION_TABLES.has(tableName)) return 'projection'
  if (tableName.startsWith('replication_') || tableName.startsWith('hub_')) return 'replication'
  return 'operational'
}

export function storageBreakdownDetails(db: Database.Database) {
  const emptyCategory = () => ({
    usefulPayloadBytes: 0,
    unusedBytes: 0,
    allocatedBytes: 0,
    tableAllocatedBytes: 0,
    indexAllocatedBytes: 0,
    objects: 0,
  })
  const categories: Record<StorageCategoryName, ReturnType<typeof emptyCategory>> = {
    canonical: emptyCategory(),
    evidence: emptyCategory(),
    sourceRaw: emptyCategory(),
    projection: emptyCategory(),
    replication: emptyCategory(),
    operational: emptyCategory(),
  }

  try {
    const objects = db.prepare(`
      SELECT s.name AS objectName,
             m.type AS objectType,
             CASE WHEN m.type = 'index' THEN m.tbl_name ELSE m.name END AS tableName,
             s.pageno AS pages,
             s.payload AS usefulPayloadBytes,
             s.unused AS unusedBytes,
             s.pgsize AS allocatedBytes
      FROM dbstat('main', 1) s
      JOIN sqlite_master m ON m.name = s.name
      WHERE m.type IN ('table', 'index')
      ORDER BY s.pgsize DESC, s.name
    `).all().map(value => {
      const row = rowRecord(value)
      const objectName = optionalString(row, 'objectName')
      const objectType = optionalString(row, 'objectType')
      const tableName = optionalString(row, 'tableName')
      if (!objectName || !tableName || (objectType !== 'table' && objectType !== 'index')) {
        throw new TypeError('SQLite dbstat object identity is invalid')
      }
      return {
        objectName,
        objectType,
        tableName,
        category: storageCategoryForTable(tableName),
        pages: requiredNumber(row, 'pages'),
        usefulPayloadBytes: requiredNumber(row, 'usefulPayloadBytes'),
        unusedBytes: requiredNumber(row, 'unusedBytes'),
        allocatedBytes: requiredNumber(row, 'allocatedBytes'),
      }
    })

    for (const item of objects) {
      const category = categories[item.category]
      category.usefulPayloadBytes += item.usefulPayloadBytes
      category.unusedBytes += item.unusedBytes
      category.allocatedBytes += item.allocatedBytes
      category.objects += 1
      if (item.objectType === 'index') category.indexAllocatedBytes += item.allocatedBytes
      else category.tableAllocatedBytes += item.allocatedBytes
    }
    return {
      available: true,
      basis: 'sqlite-dbstat-btree-aggregate',
      excludesFreelist: true,
      categories,
      objects,
    }
  } catch (error) {
    return {
      available: false,
      basis: 'sqlite-dbstat-btree-aggregate',
      excludesFreelist: true,
      reason: error instanceof Error ? error.message : String(error),
      categories,
      objects: [],
    }
  }
}

function hasIndex(db: Database.Database, indexName: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1 AS found
    FROM sqlite_master
    WHERE type = 'index' AND name = ?
  `).get(indexName))
}

export function capturedActivityDetails(db: Database.Database) {
  const now = Date.now()
  const cutoff7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()
  const cutoff30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString()
  const params = { cutoff7, cutoff30 }
  const timeIndexes = {
    sourceRecords: hasIndex(db, 'idx_source_records_captured'),
    observations: hasIndex(db, 'idx_observations_captured_at'),
    evidence: hasIndex(db, 'idx_evidence_captured_at'),
    sessions: hasIndex(db, 'idx_session_summary_projection_recent'),
  }

  const sourceRows = db.prepare(`
    SELECT sr.source_id AS sourceId,
           ai.product_id AS productId,
           ap.name AS productName,
           SUM(CASE WHEN sr.captured_at >= @cutoff7 THEN 1 ELSE 0 END) AS last7Records,
           COALESCE(SUM(CASE WHEN sr.captured_at >= @cutoff7 THEN
             length(CAST(sr.locator_json AS BLOB))
             + length(CAST(sr.payload_json AS BLOB))
             + COALESCE(length(sr.payload_blob), 0)
           ELSE 0 END), 0) AS last7Bytes,
           COUNT(*) AS last30Records,
           COALESCE(SUM(
             length(CAST(sr.locator_json AS BLOB))
             + length(CAST(sr.payload_json AS BLOB))
             + COALESCE(length(sr.payload_blob), 0)
           ), 0) AS last30Bytes
    FROM source_records sr
    JOIN agent_installations ai ON ai.id = sr.installation_id
    JOIN agent_products ap ON ap.id = ai.product_id
    WHERE sr.captured_at >= @cutoff30
    GROUP BY sr.source_id, ai.product_id, ap.name
    ORDER BY last30Bytes DESC, sr.source_id, ai.product_id
  `).all(params).map(value => {
    const row = rowRecord(value)
    const sourceId = optionalString(row, 'sourceId')
    const productId = optionalString(row, 'productId')
    if (!sourceId || !productId) throw new TypeError('SQLite Source activity identity is invalid')
    return {
      sourceId,
      productId,
      productName: optionalString(row, 'productName'),
      last7Days: {
        records: requiredNumber(row, 'last7Records'),
        storedPayloadBytesApprox: requiredNumber(row, 'last7Bytes'),
      },
      last30Days: {
        records: requiredNumber(row, 'last30Records'),
        storedPayloadBytesApprox: requiredNumber(row, 'last30Bytes'),
      },
    }
  })

  const aggregateSourceRows = (
    key: 'sourceId' | 'productId',
    includeName: boolean,
  ) => {
    const values = new Map<string, {
      id: string
      name: string | null
      last7Days: { records: number, storedPayloadBytesApprox: number }
      last30Days: { records: number, storedPayloadBytesApprox: number }
    }>()
    for (const row of sourceRows) {
      const id = row[key]
      const current = values.get(id) ?? {
        id,
        name: includeName ? row.productName : null,
        last7Days: { records: 0, storedPayloadBytesApprox: 0 },
        last30Days: { records: 0, storedPayloadBytesApprox: 0 },
      }
      current.last7Days.records += row.last7Days.records
      current.last7Days.storedPayloadBytesApprox += row.last7Days.storedPayloadBytesApprox
      current.last30Days.records += row.last30Days.records
      current.last30Days.storedPayloadBytesApprox += row.last30Days.storedPayloadBytesApprox
      values.set(id, current)
    }
    return [...values.values()]
      .sort((left, right) =>
        right.last30Days.storedPayloadBytesApprox - left.last30Days.storedPayloadBytesApprox
        || left.id.localeCompare(right.id))
      .map(item => key === 'sourceId'
        ? {
            sourceId: item.id,
            last7Days: item.last7Days,
            last30Days: item.last30Days,
          }
        : {
            productId: item.id,
            productName: item.name,
            last7Days: item.last7Days,
            last30Days: item.last30Days,
          })
  }

  const recentTable = (
    tableName: 'observations' | 'evidence',
    columnName: 'captured_at',
    bytesExpression: string,
    indexed: boolean,
  ) => {
    if (!indexed) {
      return {
        available: false,
        reason: 'deferred-time-index-missing',
        last7Days: null,
        last30Days: null,
      }
    }
    const row = rowRecord(db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN ${columnName} >= @cutoff7 THEN 1 ELSE 0 END), 0) AS last7Records,
             COALESCE(SUM(CASE WHEN ${columnName} >= @cutoff7 THEN ${bytesExpression} ELSE 0 END), 0) AS last7Bytes,
             COUNT(*) AS last30Records,
             COALESCE(SUM(${bytesExpression}), 0) AS last30Bytes
      FROM ${tableName}
      WHERE ${columnName} >= @cutoff30
    `).get(params))
    return {
      available: true,
      last7Days: {
        records: requiredNumber(row, 'last7Records'),
        logicalPayloadBytesApprox: requiredNumber(row, 'last7Bytes'),
      },
      last30Days: {
        records: requiredNumber(row, 'last30Records'),
        logicalPayloadBytesApprox: requiredNumber(row, 'last30Bytes'),
      },
    }
  }

  const canonical = recentTable(
    'observations',
    'captured_at',
    'length(CAST(payload_json AS BLOB))',
    timeIndexes.observations,
  )
  const evidence = recentTable(
    'evidence',
    'captured_at',
    'COALESCE(length(CAST(source_locator_json AS BLOB)), 0)',
    timeIndexes.evidence,
  )
  const sessionRows = timeIndexes.sessions
    ? rowRecord(db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN ended_at >= @cutoff7 THEN 1 ELSE 0 END), 0) AS last7Records,
               COUNT(*) AS last30Records
        FROM session_summary_projection
        WHERE ended_at >= @cutoff30
      `).get(params))
    : null
  const sessions = sessionRows
    ? {
        available: true,
        last7Days: { records: requiredNumber(sessionRows, 'last7Records') },
        last30Days: { records: requiredNumber(sessionRows, 'last30Records') },
      }
    : {
        available: false,
        reason: 'session-summary-time-index-missing',
        last7Days: null,
        last30Days: null,
      }

  const rawDaily = db.prepare(`
    SELECT substr(captured_at, 1, 10) AS day,
           COUNT(*) AS records,
           COALESCE(SUM(
             length(CAST(locator_json AS BLOB))
             + length(CAST(payload_json AS BLOB))
             + COALESCE(length(payload_blob), 0)
           ), 0) AS storedBytes
    FROM source_records
    WHERE captured_at >= @cutoff30
    GROUP BY substr(captured_at, 1, 10)
    ORDER BY day
  `).all(params).map(value => {
    const row = rowRecord(value)
    return {
      day: optionalString(row, 'day') ?? '',
      records: requiredNumber(row, 'records'),
      storedPayloadBytesApprox: requiredNumber(row, 'storedBytes'),
    }
  })
  const rawDailyByDay = new Map(rawDaily.map(item => [item.day, item]))
  const last30Days = Array.from({ length: 30 }, (_, index) => {
    const day = new Date(now - (29 - index) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const raw = rawDailyByDay.get(day)
    return {
      day,
      sourceRawRecords: raw?.records ?? 0,
      sourceRawStoredPayloadBytesApprox: raw?.storedPayloadBytesApprox ?? 0,
    }
  })

  const sourceRaw = {
    available: true,
    last7Days: {
      records: sourceRows.reduce((sum, row) => sum + row.last7Days.records, 0),
      storedPayloadBytesApprox: sourceRows.reduce(
        (sum, row) => sum + row.last7Days.storedPayloadBytesApprox,
        0,
      ),
    },
    last30Days: {
      records: sourceRows.reduce((sum, row) => sum + row.last30Days.records, 0),
      storedPayloadBytesApprox: sourceRows.reduce(
        (sum, row) => sum + row.last30Days.storedPayloadBytesApprox,
        0,
      ),
    },
  }

  return {
    basis: 'captured-activity-not-net-storage-growth',
    cutoffs: { last7Days: cutoff7, last30Days: cutoff30 },
    timeIndexes,
    sourceRaw,
    canonical,
    evidence,
    sessions,
    bySource: aggregateSourceRows('sourceId', false),
    byAgent: aggregateSourceRows('productId', true),
    trend: {
      last7Days: last30Days.slice(-7),
      last30Days,
    },
    rates: {
      canonicalCaptured: canonical.available && canonical.last7Days && canonical.last30Days
        ? {
            available: true,
            last7Days: {
              observationsPerDay: canonical.last7Days.records / 7,
              logicalPayloadBytesApproxPerDay: canonical.last7Days.logicalPayloadBytesApprox / 7,
            },
            last30Days: {
              observationsPerDay: canonical.last30Days.records / 30,
              logicalPayloadBytesApproxPerDay: canonical.last30Days.logicalPayloadBytesApprox / 30,
            },
          }
        : {
            available: false,
            reason: 'deferred-time-index-missing',
          },
    },
  }
}


function gzipOriginalSize(blob: unknown): number | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength < 4) return null
  const offset = blob.byteLength - 4
  return (
    blob[offset]!
    | (blob[offset + 1]! << 8)
    | (blob[offset + 2]! << 16)
    | (blob[offset + 3]! << 24)
  ) >>> 0
}

export function sourceActivityPayloadBytesBetween(
  db: Database.Database,
  afterExclusive: string,
  throughInclusive: string,
) {
  let records = 0
  let originalPayloadBytes = 0
  let unknownEncodingRecords = 0
  let invalidPayloadRecords = 0

  const rows = db.prepare(`
    SELECT payload_json AS payloadJson,
           payload_blob AS payloadBlob,
           payload_encoding AS payloadEncoding
    FROM source_records
    WHERE captured_at > ? AND captured_at <= ?
    ORDER BY captured_at ASC, id ASC
  `).iterate(afterExclusive, throughInclusive)

  for (const value of rows) {
    const row = rowRecord(value)
    const payloadEncoding = optionalString(row, 'payloadEncoding')
    records += 1

    if (payloadEncoding === 'gzip-json') {
      const rawBytes = gzipOriginalSize(row.payloadBlob)
      if (rawBytes === null) {
        invalidPayloadRecords += 1
        continue
      }
      originalPayloadBytes += rawBytes
      continue
    }

    if (payloadEncoding === 'plain-json' || payloadEncoding === 'json') {
      const payloadJson = optionalString(row, 'payloadJson')
      if (payloadJson === null) {
        invalidPayloadRecords += 1
        continue
      }
      originalPayloadBytes += Buffer.byteLength(payloadJson, 'utf8')
      continue
    }

    unknownEncodingRecords += 1
  }

  return {
    state: unknownEncodingRecords === 0 && invalidPayloadRecords === 0
      ? 'complete' as const
      : 'partial' as const,
    basis: 'source-record-payload-json-before-agentlens-compression',
    records,
    originalPayloadBytes,
    unknownEncodingRecords,
    invalidPayloadRecords,
    gzipSizeBasis: 'gzip-isize-uint32',
  }
}

export function replicationJournalDetails(
  db: Database.Database,
  cutoff7: string,
  cutoff30: string,
) {
  const tableExists = Boolean(db.prepare(`
    SELECT 1 AS found
    FROM sqlite_master
    WHERE type = 'table' AND name = 'replication_canonical_changes'
  `).get())
  if (!tableExists) {
    return {
      available: false,
      reason: 'replication-canonical-change-journal-unavailable',
      totalChanges: 0,
      distinctEntities: 0,
      changesPerDistinctEntity: null,
      last7Days: 0,
      last30Days: 0,
      byEntityType: [],
    }
  }

  const rows = db.prepare(`
    SELECT entity_type AS entityType,
           COUNT(*) AS changes,
           COUNT(DISTINCT origin_entity_id) AS distinctEntities,
           SUM(CASE WHEN changed_at >= @cutoff7 THEN 1 ELSE 0 END) AS last7Changes,
           SUM(CASE WHEN changed_at >= @cutoff30 THEN 1 ELSE 0 END) AS last30Changes
    FROM replication_canonical_changes
    GROUP BY entity_type
    ORDER BY changes DESC, entity_type
  `).all({ cutoff7, cutoff30 }).map(value => {
    const row = rowRecord(value)
    const entityType = optionalString(row, 'entityType')
    if (!entityType) throw new TypeError('SQLite replication journal entityType must be a string')
    const changes = requiredNumber(row, 'changes')
    const distinctEntities = requiredNumber(row, 'distinctEntities')
    return {
      entityType,
      changes,
      distinctEntities,
      changesPerDistinctEntity: distinctEntities > 0 ? changes / distinctEntities : null,
      last7Days: requiredNumber(row, 'last7Changes'),
      last30Days: requiredNumber(row, 'last30Changes'),
    }
  })

  const totalChanges = rows.reduce((sum, row) => sum + row.changes, 0)
  const distinctEntities = rows.reduce((sum, row) => sum + row.distinctEntities, 0)
  return {
    available: true,
    basis: 'replication-canonical-change-journal',
    timeScan: 'full-journal-no-changed-at-index',
    totalChanges,
    distinctEntities,
    changesPerDistinctEntity: distinctEntities > 0 ? totalChanges / distinctEntities : null,
    last7Days: rows.reduce((sum, row) => sum + row.last7Days, 0),
    last30Days: rows.reduce((sum, row) => sum + row.last30Days, 0),
    byEntityType: rows,
  }
}
