-- migrations/008_vendor_attachments.sql
-- =============================================================================
-- Per-vendor attachments (e.g. legal review evidence, compliance certificates).
-- Multer writes the file to UPLOAD_DIR and we store the metadata + path here.
-- =============================================================================

BEGIN;
CREATE TABLE IF NOT EXISTS vendor_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id    INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  stage        TEXT,
  filename     TEXT,
  mimetype     TEXT,
  size         INTEGER,
  stored_path  TEXT,
  uploaded_by  INTEGER REFERENCES users(id),
  uploaded_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vendor_attach ON vendor_attachments(vendor_id, stage);
COMMIT;
