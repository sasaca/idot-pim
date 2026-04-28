-- migrations/011_product_workflow_parallel_stages.sql
-- =============================================================================
-- Adds the parallel post-approval stages to the product creation workflow.
--
-- After both director approvals, a request enters PENDING_PRODUCTION_AND_ANALYSIS.
-- Two teams work independently from that state:
--   * R&D fills the Production stage (Production Plan / Packaging / Formula)
--   * Marketing fills the Competitor Analysis stage (Market & Channels /
--     Competitors)
--
-- Each team sets its own completion timestamp on submit. The request only
-- advances to CONFIRMED once both timestamps are set.
-- =============================================================================

BEGIN;

ALTER TABLE product_requests ADD COLUMN production_json         TEXT;
ALTER TABLE product_requests ADD COLUMN production_completed_at TEXT;
ALTER TABLE product_requests ADD COLUMN production_completed_by INTEGER;

ALTER TABLE product_requests ADD COLUMN competitor_json         TEXT;
ALTER TABLE product_requests ADD COLUMN competitor_completed_at TEXT;
ALTER TABLE product_requests ADD COLUMN competitor_completed_by INTEGER;

CREATE TABLE IF NOT EXISTS product_request_attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_req_id  INTEGER NOT NULL,
  stage           TEXT,                              -- 'production' | 'competitor' | etc.
  category        TEXT,                              -- 'legal_certificate' for now
  certificate_type TEXT,                             -- the dropdown value (e.g. FDA, USDA Organic)
  filename        TEXT,                              -- on-disk name in UPLOAD_DIR
  original_name   TEXT,                              -- name as the user uploaded it
  mime_type       TEXT,
  size_bytes      INTEGER,
  comment         TEXT,
  uploaded_by     INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_req_id) REFERENCES product_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pra_req ON product_request_attachments(product_req_id);

COMMIT;
