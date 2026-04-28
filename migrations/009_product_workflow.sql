-- migrations/009_product_workflow.sql
-- =============================================================================
-- Product creation workflow.
--
-- A new request lifecycle: Initiate → Details (multi-tab Marketing/Brand/R&D/
-- Forecast) → Marketing Director approval → Supply Chain Director approval →
-- Confirmation. Independent of the legacy `products` table; product_requests
-- holds the in-flight payload until the request is confirmed (at which point
-- a downstream job creates the actual SAP S/4HANA Product Master record).
--
-- Stage payloads are stored as JSON columns so we can extend the form
-- without per-field schema migrations. SAP-aligned field names are kept
-- inside the JSON so the eventual outbound integration can map cleanly.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS product_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Stage 1 — Initiate
  request_type          TEXT,                       -- NEW_PRODUCT | NEW_VARIATION | MODIFICATION | DISCONTINUATION
  product_name          TEXT,
  requestor_user_id     INTEGER,
  requestor_name        TEXT,                       -- captured at submit time so it survives user renames
  requestor_email       TEXT,
  request_date          TEXT,                       -- yyyy-mm-dd; populated on submit
  reference_sku         TEXT,                       -- optional: existing SKU the requestor used as a starting point
  reference_product_json TEXT,                      -- snapshot of the chosen reference product (for BOM reuse later)

  -- Stage 2 — Details (one JSON blob per tab)
  marketing_json        TEXT,                       -- {market, rationale, positioning, launch_plan, packaging_status, formula_status}
  brand_json            TEXT,                       -- {category_grouper, category, family_brand, brand, sub_brand}
  rnd_json              TEXT,                       -- {dimensions, weights, mfg_price, retail_price_usd, retail_price_local, fx_rate, contract_status, ...}
  forecast_json         TEXT,                       -- {y1_jan..y1_dec, y2..y5, total_y1, total_y5}

  -- Workflow state
  workflow_state        TEXT NOT NULL DEFAULT 'DRAFT',
  workflow_updated_at   TEXT,
  workflow_updated_by   INTEGER,

  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pr_state    ON product_requests(workflow_state);
CREATE INDEX IF NOT EXISTS idx_pr_reqstor  ON product_requests(requestor_user_id);
CREATE INDEX IF NOT EXISTS idx_pr_created  ON product_requests(created_at);

CREATE TABLE IF NOT EXISTS product_workflow_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_req_id  INTEGER NOT NULL,
  action          TEXT    NOT NULL,
  from_state      TEXT    NOT NULL,
  to_state        TEXT    NOT NULL,
  actor_user_id   INTEGER,
  actor_role      TEXT,
  reason_code     TEXT,                              -- optional structured reason for reject / request-info
  note            TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_req_id) REFERENCES product_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pwh_req     ON product_workflow_history(product_req_id);
CREATE INDEX IF NOT EXISTS idx_pwh_created ON product_workflow_history(created_at);

CREATE TABLE IF NOT EXISTS product_workflow_comments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_req_id  INTEGER NOT NULL,
  author_user_id  INTEGER,
  author_role     TEXT,
  stage           TEXT,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (product_req_id) REFERENCES product_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pwc_req ON product_workflow_comments(product_req_id);

COMMIT;
