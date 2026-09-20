import type Database from 'better-sqlite3'
import type { AssetStateObservation } from '@agent-lens/core'

function encodedValue(value: AssetStateObservation['value']): string {
  return value === 'unknown' ? 'unknown' : value ? 'true' : 'false'
}

export function upsertAssetCurrentState(
  db: Database.Database,
  state: AssetStateObservation,
): void {
  db.prepare(`
    INSERT INTO asset_current_state(
      asset_binding_id,
      state,
      observation_id,
      value,
      observed_at,
      evidence_refs_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_binding_id, state) DO UPDATE SET
      observation_id = excluded.observation_id,
      value = excluded.value,
      observed_at = excluded.observed_at,
      evidence_refs_json = excluded.evidence_refs_json
    WHERE excluded.observation_id = asset_current_state.observation_id
       OR excluded.observed_at > asset_current_state.observed_at
       OR (
         excluded.observed_at = asset_current_state.observed_at
         AND excluded.observation_id > asset_current_state.observation_id
       )
  `).run(
    state.assetBindingId,
    state.state,
    state.id,
    encodedValue(state.value),
    state.observedAt,
    JSON.stringify(state.evidenceRefs),
  )
}

export function rebuildAssetCurrentState(db: Database.Database): void {
  db.exec(`
    DELETE FROM asset_current_state;

    INSERT INTO asset_current_state(
      asset_binding_id,
      state,
      observation_id,
      value,
      observed_at,
      evidence_refs_json
    )
    SELECT
      ranked.asset_binding_id,
      ranked.state,
      ranked.id,
      ranked.value,
      ranked.observed_at,
      ranked.evidence_refs_json
    FROM (
      SELECT
        history.*,
        ROW_NUMBER() OVER (
          PARTITION BY history.asset_binding_id, history.state
          ORDER BY history.observed_at DESC, history.id DESC
        ) AS state_rank
      FROM asset_state_observations AS history
    ) AS ranked
    WHERE ranked.state_rank = 1;
  `)
}
