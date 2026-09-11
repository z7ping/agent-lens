ALTER TABLE asset_bindings ADD COLUMN scope TEXT;
ALTER TABLE asset_bindings ADD COLUMN scope_root TEXT;

CREATE INDEX IF NOT EXISTS idx_asset_bindings_scope
  ON asset_bindings(scope, scope_root);
