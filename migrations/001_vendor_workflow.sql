-- migrations/001_vendor_workflow.sql
-- =============================================================================
-- Vendor onboarding workflow migration (patched for this project).
--
-- Adds:
--   * vendors.workflow_state / workflow_updated_at / workflow_updated_by
--   * vendor_workflow_history        (every transition, for audit)
--   * vendor_workflow_comments       (free-text notes from any reviewer)
--
-- NOTE: The upstream addon also seeds a `roles` table, but this project
-- keeps roles as a TEXT column on `users` — no `roles` table exists, so
-- that INSERT has been removed. Demo users for the new roles are seeded
-- out-of-band in the app, not here.
--
-- Run with:
--     sqlite3 db/idot.sqlite < migrations/001_vendor_workflow.sql
-- =============================================================================

BEGIN;

ALTER TABLE vendors ADD COLUMN workflow_state TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE vendors ADD COLUMN workflow_updated_at TEXT;
ALTER TABLE vendors ADD COLUMN workflow_updated_by INTEGER;

CREATE TABLE IF NOT EXISTS vendor_workflow_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id       INTEGER NOT NULL,
  action          TEXT    NOT NULL,
  from_state      TEXT    NOT NULL,
  to_state        TEXT    NOT NULL,
  actor_user_id   INTEGER,
  actor_role      TEXT,
  note            TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vwh_vendor ON vendor_workflow_history(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vwh_created ON vendor_workflow_history(created_at);

CREATE TABLE IF NOT EXISTS vendor_workflow_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id       INTEGER NOT NULL,
  author_user_id  INTEGER,
  author_role     TEXT,
  stage           TEXT,
  body            TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (vendor_id) REFERENCES vendors(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_vwc_vendor ON vendor_workflow_comments(vendor_id);

COMMIT;
