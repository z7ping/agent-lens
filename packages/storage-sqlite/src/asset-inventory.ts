import type {
  AssetBinding,
  AssetDefinition,
  AssetInventoryEntry,
  AssetInventoryReader,
  AssetState,
  AssetScope,
  AssetStateObservation,
  AssetType,
} from '@agent-lens/core'
import { SqliteExecutor } from './executor'

type AssetRow = Record<string, unknown>
const ASSET_TYPES = ['skill', 'mcp', 'plugin', 'extension', 'hook', 'memory', 'prompt', 'theme', 'context', 'rule', 'builtin', 'unknown'] as const
const ASSET_SCOPES = ['installation', 'user', 'project', 'workspace'] as const
const ASSET_STATES = ['installed', 'configured', 'enabled', 'discoverable', 'exposed', 'invoked'] as const

function rowRecord(value: unknown): AssetRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('SQLite asset inventory query returned a non-object row')
  }
  return value as AssetRow
}

function requiredString(row: AssetRow, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new TypeError(`SQLite asset inventory field ${key} must be a string`)
  return value
}

function optionalString(row: AssetRow, key: string): string | undefined {
  const value = row[key]
  if (value == null) return undefined
  if (typeof value !== 'string') throw new TypeError(`SQLite asset inventory field ${key} must be a string or null`)
  return value
}

function enumString<const T extends readonly string[]>(row: AssetRow, key: string, allowed: T): T[number] {
  const value = requiredString(row, key)
  if (!(allowed as readonly string[]).includes(value)) {
    throw new TypeError(`SQLite asset inventory field ${key} has unsupported value: ${value}`)
  }
  return value as T[number]
}

function decodeEvidenceRefs(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('SQLite asset inventory evidence_refs_json contains invalid JSON')
  }
  if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string')) {
    throw new TypeError('SQLite asset inventory evidence_refs_json must contain a JSON string array')
  }
  return parsed
}

function mapDefinition(value: unknown): AssetDefinition {
  const row = rowRecord(value)
  const displayName = optionalString(row, 'display_name')
  const upstreamIdentity = optionalString(row, 'upstream_identity')
  return {
    id: requiredString(row, 'asset_id'),
    type: enumString(row, 'asset_type', ASSET_TYPES) as AssetType,
    canonicalName: requiredString(row, 'canonical_name'),
    ...(displayName === undefined ? {} : { displayName }),
    ...(upstreamIdentity === undefined ? {} : { upstreamIdentity }),
  }
}

function mapBinding(value: unknown): AssetBinding {
  const row = rowRecord(value)
  const runtimeProfileId = optionalString(row, 'runtime_profile_id')
  const rawScope = optionalString(row, 'scope')
  const scope = rawScope === undefined
    ? undefined
    : (ASSET_SCOPES as readonly string[]).includes(rawScope)
      ? rawScope as AssetScope
      : (() => { throw new TypeError(`SQLite asset inventory field scope has unsupported value: ${rawScope}`) })()
  const scopeRoot = optionalString(row, 'scope_root')
  const path = optionalString(row, 'path')
  const source = optionalString(row, 'source')
  const version = optionalString(row, 'version')
  return {
    id: requiredString(row, 'binding_id'),
    assetId: requiredString(row, 'asset_id'),
    installationId: requiredString(row, 'installation_id'),
    ...(runtimeProfileId === undefined ? {} : { runtimeProfileId }),
    ...(scope === undefined ? {} : { scope }),
    ...(scopeRoot === undefined ? {} : { scopeRoot }),
    ...(path === undefined ? {} : { path }),
    ...(source === undefined ? {} : { source }),
    ...(version === undefined ? {} : { version }),
  }
}

function mapState(value: unknown): AssetStateObservation {
  const row = rowRecord(value)
  const rawValue = requiredString(row, 'value')
  const stateValue = rawValue === 'true' ? true : rawValue === 'false' ? false : rawValue === 'unknown' ? 'unknown' : null
  if (stateValue === null) throw new TypeError(`SQLite asset inventory field value has unsupported value: ${rawValue}`)
  return {
    id: requiredString(row, 'id'),
    assetBindingId: requiredString(row, 'asset_binding_id'),
    state: enumString(row, 'state', ASSET_STATES) as AssetState,
    value: stateValue,
    observedAt: requiredString(row, 'observed_at'),
    evidenceRefs: decodeEvidenceRefs(row.evidence_refs_json),
  }
}

export class SqliteAssetInventoryReader implements AssetInventoryReader {
  constructor(private readonly executor: SqliteExecutor) {}

  async listByInstallation(installationId: string): Promise<AssetInventoryEntry[]> {
    return this.executor.run(() => {
      const bindings = this.executor.db.prepare(`
        SELECT
          b.id AS binding_id,
          b.asset_id AS asset_id,
          b.installation_id AS installation_id,
          b.runtime_profile_id AS runtime_profile_id,
          b.scope AS scope,
          b.scope_root AS scope_root,
          b.path AS path,
          b.source AS source,
          b.version AS version,
          d.type AS asset_type,
          d.canonical_name AS canonical_name,
          d.display_name AS display_name,
          d.upstream_identity AS upstream_identity
        FROM asset_bindings b
        JOIN asset_definitions d ON d.id = b.asset_id
        WHERE b.installation_id = ?
        ORDER BY d.type, COALESCE(d.display_name, d.canonical_name), b.id
      `).all(installationId)

      const states = this.executor.db.prepare(`
        SELECT * FROM asset_state_observations
        WHERE asset_binding_id = ?
        ORDER BY observed_at DESC, id DESC
      `)

      return bindings.map(row => {
        const binding = mapBinding(row)
        return {
          definition: mapDefinition(row),
          binding,
          states: states.all(binding.id).map(mapState),
        }
      })
    })
  }
}
