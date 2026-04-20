-- migrations/006_form_domain.sql
-- =============================================================================
-- Tag each form_definition with a master-data domain so role-scoped views
-- (Vendor Admin, Customer Admin, etc.) can filter down to the templates that
-- belong to their area.
--
-- Values used: 'general' | 'vendor_master' | 'customer_master' | 'product_master'
--
-- Run:  sqlite3 db/idot.sqlite < migrations/006_form_domain.sql
-- =============================================================================

BEGIN;
ALTER TABLE form_definitions ADD COLUMN domain TEXT NOT NULL DEFAULT 'general';
CREATE INDEX IF NOT EXISTS idx_form_def_domain ON form_definitions(domain);
COMMIT;
