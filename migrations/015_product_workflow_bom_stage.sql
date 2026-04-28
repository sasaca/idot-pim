-- migrations/015_product_workflow_bom_stage.sql
-- =============================================================================
-- Adds the final R&D BOM-selection stage. Once all four parallel flags
-- (production, packaging, design, competitor) are set, the request advances
-- to PENDING_BOM instead of CONFIRMED. The R&D team then assembles two BOMs
-- (packaging + formula) and submits to confirm the request.
-- =============================================================================

BEGIN;

ALTER TABLE product_requests ADD COLUMN bom_packaging_json TEXT;
ALTER TABLE product_requests ADD COLUMN bom_formula_json   TEXT;
ALTER TABLE product_requests ADD COLUMN bom_completed_at   TEXT;
ALTER TABLE product_requests ADD COLUMN bom_completed_by   INTEGER;

COMMIT;
