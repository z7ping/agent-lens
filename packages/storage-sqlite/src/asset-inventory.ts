import type {
  AssetBinding,
  AssetDefinition,
  AssetInventoryEntry,
  AssetInventoryReader,
  AssetStateObservation,
} from '@agent-lens/core'
import { SqliteExecutor } from './executor'

function decodeEvidenceRefs(value: unknown): string[] {
  if (typeof value !== 'string' || value.length === 0) return []
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
}

function mapDefinition(row: any): AssetDefinition {
  return {
    id: row.asset_id,
    type: row.asset_type,
    canonicalName: row.canonical_name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.upstream_identity ? { upstreamIdentity: row.upstream_identity } : {}),
  } as AssetDefinition
}

function mapBinding(row: any): AssetBinding {
  return {
    id: row.binding_id,
    assetId: row.asset_id,
    installationId: row.installation_id,
    ...(row.path ? { path: row.path } : {}),
    ...(row.source ? { source: row.source } : {}),
    ...(row.version ? { version: row.version } : {}),
  }
}

function mapState(row: any): AssetStateObservation {
  const value = row.value === 'true' ? true : row.value === 'false' ? false : 'unknown'
  return {
    id: row.id,
    assetBindingId: row.asset_binding_id,
    state: row.state,
    value,
    observedAt: row.observed_at,
    evidenceRefs: decodeEvidenceRefs(row.evidence_refs_json),
  } as AssetStateObservation
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

      return bindings.map(row => ({
        definition: mapDefinition(row),
        binding: mapBinding(row),
        states: states.all((row as any).binding_id).map(mapState),
      }))
    })
  }
}
