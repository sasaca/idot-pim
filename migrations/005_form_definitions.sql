-- migrations/005_form_definitions.sql
-- =============================================================================
-- Drag-and-drop form builder: stores form blueprints + user submissions.
-- Run:  sqlite3 db/idot.sqlite < migrations/005_form_definitions.sql
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS form_definitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  description   TEXT,
  schema_json   TEXT NOT NULL,
  is_published  INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_def_name ON form_definitions(name);

CREATE TABLE IF NOT EXISTS form_submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id       INTEGER NOT NULL REFERENCES form_definitions(id) ON DELETE CASCADE,
  data_json     TEXT NOT NULL,
  submitted_by  INTEGER REFERENCES users(id),
  submitted_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_sub_form ON form_submissions(form_id);

COMMIT;
