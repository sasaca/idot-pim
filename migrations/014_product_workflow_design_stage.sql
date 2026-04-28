-- migrations/014_product_workflow_design_stage.sql
-- =============================================================================
-- Adds the Design stage. Runs in parallel with Packaging Materials inside
-- R&D's track (both unlock once Production is submitted). The request now
-- requires FOUR completion flags before advancing to CONFIRMED:
--   production_completed_at AND
--   packaging_completed_at  AND
--   design_completed_at     AND
--   competitor_completed_at
-- =============================================================================

BEGIN;

ALTER TABLE product_requests ADD COLUMN design_json         TEXT;
ALTER TABLE product_requests ADD COLUMN design_completed_at TEXT;
ALTER TABLE product_requests ADD COLUMN design_completed_by INTEGER;

COMMIT;
