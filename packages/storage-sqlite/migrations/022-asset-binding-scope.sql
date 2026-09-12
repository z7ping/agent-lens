ALTER TABLE asset_bindings
  ADD COLUMN scope TEXT
  CHECK (scope IS NULL OR scope IN ('installation', 'user', 'project', 'workspace'));

ALTER TABLE asset_bindings
  ADD COLUMN scope_root TEXT;
