-- migrations/010_product_workflow_demo_users.sql
-- =============================================================================
-- Demo users for the product creation workflow approver roles.
-- Idempotent via INSERT OR IGNORE on the unique `email` column.
-- =============================================================================

BEGIN;
INSERT OR IGNORE INTO users (email, name, role, department, active) VALUES
  ('mktg.director@demo.com', 'Maddie Marketing', 'MKTG_DIRECTOR', 'Marketing',    1),
  ('sc.director@demo.com',   'Sid Supply',       'SC_DIRECTOR',   'Supply Chain', 1);
COMMIT;
