CREATE TABLE IF NOT EXISTS asset_current_state (
  asset_binding_id TEXT NOT NULL REFERENCES asset_bindings(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  observation_id TEXT NOT NULL REFERENCES asset_state_observations(id) ON DELETE CASCADE,
  value TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(asset_binding_id, state)
);

CREATE INDEX IF NOT EXISTS idx_asset_current_state_binding
ON asset_current_state(asset_binding_id, state);

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