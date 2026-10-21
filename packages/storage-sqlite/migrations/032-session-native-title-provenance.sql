-- Persist provenance without duplicating native session content.
-- Legacy titles stay unverified until the source provides a new native fact.
ALTER TABLE logical_sessions ADD COLUMN title_kind TEXT CHECK (title_kind IN ('explicit', 'generated', 'unverified'));
