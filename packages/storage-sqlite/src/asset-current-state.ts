import type Database from 'better-sqlite3'
import type { AssetStateObservation } from '@agent-lens/core'

/** Current certified asset state only; never persist historical observations. */
export function upsertAssetCurrentState(db:Database.Database,state:AssetStateObservation):void {
  const value=state.value==='unknown'?'unknown':state.value?'true':'false'
  db.prepare(`
    DELETE FROM asset_current_state
    WHERE state_id=? AND (asset_binding_id<>? OR state<>?)
  `).run(state.id,state.assetBindingId,state.state)
  db.prepare(`
    INSERT INTO asset_current_state(asset_binding_id,state,state_id,value,observed_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(asset_binding_id,state) DO UPDATE SET
      state_id=excluded.state_id,
      value=excluded.value,
      observed_at=excluded.observed_at
    WHERE excluded.state_id=asset_current_state.state_id
       OR excluded.observed_at>asset_current_state.observed_at
       OR (excluded.observed_at=asset_current_state.observed_at
           AND excluded.state_id>asset_current_state.state_id)
  `).run(state.assetBindingId,state.state,state.id,value,state.observedAt)
}
