-- migrations/018_product_workflow_legal_and_mdm.sql
-- =============================================================================
-- Adds the post-director Legal + MDM parallel stage. After both directors
-- (R&D + Quality) approve, the request enters PENDING_LEGAL_AND_MDM where:
--   * Legal team submits certifications (with attachments) and confirms
--     packaging country registrations.
--   * MDM team reviews / edits the BOM components R&D filled in.
-- The request only advances to CONFIRMED once both teams submit.
-- =============================================================================

BEGIN;

ALTER TABLE product_requests ADD COLUMN legal_json         TEXT;
ALTER TABLE product_requests ADD COLUMN legal_completed_at TEXT;
ALTER TABLE product_requests ADD COLUMN legal_completed_by INTEGER;

ALTER TABLE product_requests ADD COLUMN mdm_completed_at TEXT;
ALTER TABLE product_requests ADD COLUMN mdm_completed_by INTEGER;

COMMIT;
