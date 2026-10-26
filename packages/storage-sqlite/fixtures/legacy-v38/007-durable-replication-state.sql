CREATE TABLE replication_streams (
  stream_id TEXT PRIMARY KEY,
  relationship_id TEXT NOT NULL,
  hub_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'rollover-required')),
  next_sequence INTEGER NOT NULL CHECK (next_sequence >= 1),
  ack_sequence INTEGER NOT NULL CHECK (ack_sequence >= 0),
  policy_revision TEXT NOT NULL,
  history_revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (next_sequence > ack_sequence)
);

CREATE INDEX idx_replication_stream_relationship
  ON replication_streams(relationship_id, created_at, stream_id);

CREATE TABLE replication_entity_state (
  stream_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  last_candidate_hash TEXT NOT NULL,
  last_pending_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, generation_id, dedup_key),
  FOREIGN KEY (stream_id) REFERENCES replication_streams(stream_id) ON DELETE CASCADE
);

CREATE TABLE replication_pending_entities (
  id TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  origin_entity_id TEXT NOT NULL,
  candidate_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('bootstrap', 'incremental', 'reconcile')),
  policy_revision TEXT NOT NULL,
  history_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  frozen_sequence INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (stream_id) REFERENCES replication_streams(stream_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_replication_pending_open_dedup
  ON replication_pending_entities(stream_id, generation_id, dedup_key)
  WHERE frozen_sequence IS NULL;

CREATE INDEX idx_replication_pending_ready
  ON replication_pending_entities(stream_id, generation_id, frozen_sequence, created_at, id);

CREATE TABLE replication_frozen_batches (
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  generation_id TEXT NOT NULL,
  batch_id TEXT NOT NULL UNIQUE,
  content_hash TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('bootstrap', 'incremental', 'reconcile')),
  policy_revision TEXT NOT NULL,
  history_revision TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('frozen', 'acked')),
  frozen_at TEXT NOT NULL,
  acked_at TEXT,
  PRIMARY KEY (stream_id, sequence),
  FOREIGN KEY (stream_id) REFERENCES replication_streams(stream_id) ON DELETE CASCADE
);

CREATE INDEX idx_replication_frozen_status
  ON replication_frozen_batches(stream_id, status, sequence);

CREATE TABLE replication_batch_items (
  stream_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  pending_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (stream_id, sequence, pending_id),
  FOREIGN KEY (stream_id, sequence) REFERENCES replication_frozen_batches(stream_id, sequence) ON DELETE CASCADE,
  FOREIGN KEY (pending_id) REFERENCES replication_pending_entities(id) ON DELETE RESTRICT
);

CREATE TABLE replication_reconciliation_cursors (
  stream_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (stream_id, entity_type),
  FOREIGN KEY (stream_id) REFERENCES replication_streams(stream_id) ON DELETE CASCADE
);
