-- migrations/004_vendor_workflow_config.sql
-- =============================================================================
-- Configurable vendor onboarding workflow.
--
--   * vendor_workflow_config    single active configuration describing which
--                               stages run and under what trigger conditions.
--   * vendors.enabled_stages    JSON array of stage names active for THIS
--                               vendor (computed at submit time from the
--                               config + the submitted form values).
--
-- Run with:
--   sqlite3 db/idot.sqlite < migrations/004_vendor_workflow_config.sql
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS vendor_workflow_config (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 0,
  stages_json TEXT NOT NULL,
  updated_at  TEXT DEFAULT (datetime('now')),
  updated_by  INTEGER REFERENCES users(id)
);

ALTER TABLE vendors ADD COLUMN enabled_stages TEXT;

-- Seed a default config: all four stages active, no triggers (they always run).
INSERT OR IGNORE INTO vendor_workflow_config (id, name, is_active, stages_json) VALUES
  (1, 'Default', 1, '[
    {"stage":"PENDING_SC_REVIEW","label":"Supply Chain Review","triggers":[],"trigger_mode":"ALL"},
    {"stage":"PENDING_SUPPLIER","label":"Supplier Form","triggers":[],"trigger_mode":"ALL"},
    {"stage":"PENDING_VENDOR_ADMIN","label":"Vendor Admin Form","triggers":[],"trigger_mode":"ALL"},
    {"stage":"PENDING_LEGAL","label":"Legal Review","triggers":[],"trigger_mode":"ALL"}
  ]');

COMMIT;
