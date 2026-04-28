-- migrations/013_product_workflow_packaging_stage.sql
-- =============================================================================
-- Adds the R&D "Packaging Materials" stage that follows the Production stage.
-- Production → Packaging is sequential within R&D's track. Marketing's
-- competitor-analysis track stays parallel.
--
-- The state column doesn't change — we still track everything inside
-- PENDING_PRODUCTION_AND_ANALYSIS, but now the request only advances to
-- CONFIRMED when production_completed_at AND packaging_completed_at AND
-- competitor_completed_at are all set.
-- =============================================================================

BEGIN;

ALTER TABLE product_requests ADD COLUMN packaging_json         TEXT;
ALTER TABLE product_requests ADD COLUMN packaging_completed_at TEXT;
ALTER TABLE product_requests ADD COLUMN packaging_completed_by INTEGER;

COMMIT;
