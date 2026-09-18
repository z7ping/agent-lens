ALTER TABLE asset_bindings
  ADD COLUMN package_identity TEXT;

CREATE INDEX IF NOT EXISTS idx_asset_bindings_package_identity
  ON asset_bindings(installation_id, package_identity);

ALTER TABLE source_runtime_status
  ADD COLUMN package_identity_coverage TEXT
  CHECK (
    package_identity_coverage IS NULL
    OR package_identity_coverage IN ('complete', 'partial', 'unknown', 'unavailable')
  );
