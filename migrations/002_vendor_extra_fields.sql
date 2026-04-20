-- migrations/002_vendor_extra_fields.sql
-- =============================================================================
-- Adds a generic JSON column to vendors for holding form fields that don't map
-- to a dedicated column. Used by the new onboarding form (requestor info,
-- compliance/sustainability/CSR answers, etc.).
--
-- Run with:
--     sqlite3 db/idot.sqlite < migrations/002_vendor_extra_fields.sql
-- =============================================================================

BEGIN;
ALTER TABLE vendors ADD COLUMN extra_fields TEXT;
COMMIT;
