CREATE TABLE IF NOT EXISTS hub_replica_generations (
  origin_node_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'active', 'retired')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT,
  PRIMARY KEY(origin_node_id, generation_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_replica_generation_active
  ON hub_replica_generations(origin_node_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS hub_replication_streams (
  stream_id TEXT PRIMARY KEY,
  origin_node_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  ack_sequence INTEGER NOT NULL DEFAULT 0 CHECK (ack_sequence >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hub_replication_stream_node
  ON hub_replication_streams(origin_node_id, status, stream_id);

CREATE TABLE IF NOT EXISTS hub_committed_batches (
  stream_id TEXT NOT NULL REFERENCES hub_replication_streams(stream_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  origin_node_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY(stream_id, sequence),
  UNIQUE(batch_id)
);

CREATE TABLE IF NOT EXISTS hub_remote_replica_entities (
  origin_node_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  origin_entity_id TEXT NOT NULL,
  replica_key TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('node', 'shared')),
  entity_version INTEGER NOT NULL CHECK (entity_version >= 1),
  content_hash TEXT NOT NULL,
  body_json TEXT NOT NULL,
  references_json TEXT,
  shared_identity_json TEXT,
  updated_sequence INTEGER NOT NULL CHECK (updated_sequence >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(origin_node_id, generation_id, entity_type, origin_entity_id),
  FOREIGN KEY(origin_node_id, generation_id)
    REFERENCES hub_replica_generations(origin_node_id, generation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_remote_replica_key_generation
  ON hub_remote_replica_entities(origin_node_id, generation_id, replica_key);
CREATE INDEX IF NOT EXISTS idx_hub_remote_replica_generation_type
  ON hub_remote_replica_entities(origin_node_id, generation_id, entity_type, replica_key);

CREATE TABLE IF NOT EXISTS hub_remote_shared_identity_state (
  origin_node_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  origin_entity_id TEXT NOT NULL,
  state_kind TEXT NOT NULL CHECK (state_kind IN ('shared-root', 'conditional-membership')),
  identity_algorithm TEXT NOT NULL,
  normalized_identity TEXT,
  shared_key TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL CHECK (updated_sequence >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(origin_node_id, generation_id, entity_type, origin_entity_id, state_kind),
  FOREIGN KEY(origin_node_id, generation_id)
    REFERENCES hub_replica_generations(origin_node_id, generation_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_hub_remote_shared_key
  ON hub_remote_shared_identity_state(entity_type, shared_key, state_kind);
