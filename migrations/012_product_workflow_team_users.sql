-- migrations/012_product_workflow_team_users.sql
-- =============================================================================
-- Demo users for the parallel post-approval product stages.
-- =============================================================================

BEGIN;
INSERT OR IGNORE INTO users (email, name, role, department, active) VALUES
  ('rnd.team@demo.com',       'Riley R&D',     'RND_TEAM',       'R&D',       1),
  ('marketing.team@demo.com', 'Margo Marketer','MARKETING_TEAM', 'Marketing', 1);
COMMIT;
