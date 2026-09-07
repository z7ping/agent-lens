ALTER TABLE session_summary_projection ADD COLUMN user_turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_summary_projection ADD COLUMN system_context_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_summary_projection ADD COLUMN internal_review_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_summary_projection ADD COLUMN other_event_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_summary_projection ADD COLUMN session_activity TEXT NOT NULL DEFAULT 'user-task';
ALTER TABLE session_summary_projection ADD COLUMN activity_source_label TEXT;
ALTER TABLE session_summary_projection ADD COLUMN parent_session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_session_summary_projection_activity_recent
ON session_summary_projection(session_activity, ended_at DESC, logical_session_id ASC);

CREATE INDEX IF NOT EXISTS idx_session_summary_projection_parent
ON session_summary_projection(parent_session_id, session_activity);
