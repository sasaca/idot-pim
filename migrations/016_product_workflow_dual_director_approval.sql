-- migrations/016_product_workflow_dual_director_approval.sql
-- =============================================================================
-- Adds the post-BOM dual director approval. After R&D submits the BOM the
-- request moves into PENDING_RND_AND_QUALITY_DIRECTORS where R&D Director
-- and Quality Director must each approve in parallel before CONFIRMED.
-- Either director can also reject (terminal) or request more information.
-- =============================================================================

BEGIN;

ALTER TABLE product_requests ADD COLUMN rnd_director_approved_at     TEXT;
ALTER TABLE product_requests ADD COLUMN rnd_director_approved_by     INTEGER;
ALTER TABLE product_requests ADD COLUMN rnd_director_note            TEXT;

ALTER TABLE product_requests ADD COLUMN quality_director_approved_at TEXT;
ALTER TABLE product_requests ADD COLUMN quality_director_approved_by INTEGER;
ALTER TABLE product_requests ADD COLUMN quality_director_note        TEXT;

COMMIT;
