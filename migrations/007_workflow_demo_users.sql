-- migrations/007_workflow_demo_users.sql
-- =============================================================================
-- Demo users required for the vendor onboarding workflow roles that aren't
-- part of the default seed (db/seed.js). Idempotent via INSERT OR IGNORE on
-- the unique `email` column, so re-running has no effect.
-- =============================================================================

BEGIN;
INSERT OR IGNORE INTO users (email, name, role, department, active) VALUES
  ('workflow.requestor@demo.com', 'Ren Requestor',    'REQUESTOR',    'Business',    1),
  ('vendor.admin@demo.com',        'Vic VendorAdmin', 'VENDOR_ADMIN', 'Master Data', 1);
COMMIT;
