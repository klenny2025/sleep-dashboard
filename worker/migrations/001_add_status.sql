-- Adds status column if missing (safe to run once)
-- NOTE: SQLite doesn't support IF NOT EXISTS for ADD COLUMN in all versions.
-- D1 (SQLite) supports it? If not, run only once.
ALTER TABLE workers_sleep_entries ADD COLUMN status TEXT NOT NULL DEFAULT 'OK';
