-- migrations/017_product_workflow_dual_director_users.sql
-- =============================================================================
-- Demo users for the post-BOM dual director approval.
-- =============================================================================

BEGIN;
INSERT OR IGNORE INTO users (email, name, role, department, active) VALUES
  ('rnd.director@demo.com',     'Reggie R&D Director',     'RND_DIRECTOR',     'R&D',     1),
  ('quality.director@demo.com', 'Quincy Quality Director', 'QUALITY_DIRECTOR', 'Quality', 1);
COMMIT;
