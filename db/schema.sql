-- ============================================================
-- iDOT PIM — Master Data Management Schema
-- ============================================================
-- Supports Vendor Master, Customer Master, and Product Master
-- domains with configurable workflows, approvals, compliance,
-- audit trail, and reference data.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- USERS & ROLES ----------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,  -- BU_REQUESTOR | SUPPLY_CHAIN | LEGAL | MASTER_ADMIN | FINANCE | SALES | REGIONAL | SUPPLIER | CUSTOMER | PRODUCT_OWNER | CUSTOMER_SERVICE | MDM_TEAM | QUALITY_REG | CORP_SECURITY | CREDIT_MGMT | FIN_MGMT | SUPERVISOR
  department    TEXT,
  legal_entity  TEXT,
  region        TEXT,
  sub_region    TEXT,
  phone         TEXT,
  active        INTEGER DEFAULT 1,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- ---------- REFERENCE DATA (drop-downs) ----------
CREATE TABLE IF NOT EXISTS reference_data (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  category   TEXT NOT NULL,   -- country | state | currency | payment_terms | commodity_code | uom | etc.
  code       TEXT NOT NULL,
  label      TEXT NOT NULL,
  parent     TEXT,            -- for hierarchical (state -> country)
  metadata   TEXT,            -- JSON blob
  active     INTEGER DEFAULT 1,
  UNIQUE(category, code)
);
CREATE INDEX IF NOT EXISTS idx_ref_cat ON reference_data(category);

-- ---------- MASTER RECORDS ----------
-- Vendors (suppliers)
CREATE TABLE IF NOT EXISTS vendors (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  erp_supplier_id       TEXT UNIQUE,
  legal_name            TEXT NOT NULL,
  secondary_alpha_name  TEXT,
  duns                  TEXT,
  tax_id                TEXT,
  additional_tax_id     TEXT,
  parent_id             INTEGER REFERENCES vendors(id),
  parent_duns           TEXT,
  supplier_attribute    TEXT,  -- WHQ | Country HQ | BU | Intercompany | Local | Regional HQ
  category_l1           TEXT,
  category_l2           TEXT,
  category_l3           TEXT,
  category_l4           TEXT,
  commodity_code        TEXT,
  erp_instance          TEXT,
  line_of_business      TEXT,
  factory_or_field      TEXT,
  currency_code         TEXT,
  ap_payment_terms      TEXT,
  high_level_class      TEXT,   -- PO | NONPO | Mixed
  e_invoice_flag        TEXT,
  e_invoice_date        TEXT,
  status                TEXT DEFAULT 'PENDING', -- ACTIVE | PENDING | INACTIVE | REJECTED
  risk_rating           TEXT,   -- LOW | MEDIUM | HIGH
  one_time_vendor       INTEGER DEFAULT 0,
  -- addresses stored separately
  primary_contact_name  TEXT,
  primary_contact_email TEXT,
  primary_contact_phone TEXT,
  payment_instrument    TEXT,
  ap_gl_class           TEXT,
  tax_rate_area         TEXT,
  tax_explanation_code  TEXT,
  address_type_payables TEXT,
  reporting_code        TEXT,
  hold_payment_code     TEXT,
  hold_order_code       TEXT,
  person_corp_code      TEXT,
  send_method           TEXT,
  financial_soundness_verified INTEGER,
  mk_denial_verified    INTEGER,
  flags_json            TEXT,   -- compliance yes/no dict
  created_by            INTEGER REFERENCES users(id),
  created_at            TEXT DEFAULT (datetime('now')),
  updated_at            TEXT DEFAULT (datetime('now')),
  deactivated_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_vendor_name ON vendors(legal_name);
CREATE INDEX IF NOT EXISTS idx_vendor_tax ON vendors(tax_id);
CREATE INDEX IF NOT EXISTS idx_vendor_duns ON vendors(duns);
CREATE INDEX IF NOT EXISTS idx_vendor_status ON vendors(status);

-- Vendor Addresses (supports multiple manufacturing addresses, remit-to, primary)
CREATE TABLE IF NOT EXISTS vendor_addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id     INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  address_type  TEXT NOT NULL,  -- PRIMARY | REMIT_TO | MANUFACTURING
  line1         TEXT,
  line2         TEXT,
  line3         TEXT,
  line4         TEXT,
  city          TEXT,
  state         TEXT,
  zip           TEXT,
  county        TEXT,
  country       TEXT,
  email         TEXT,
  po_email      TEXT,
  effective_date TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Vendor Banking Information
CREATE TABLE IF NOT EXISTS vendor_banks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id     INTEGER NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  bank_name     TEXT,
  bank_account  TEXT,
  bank_transit  TEXT,
  iban          TEXT,
  swift         TEXT,
  bank_country  TEXT,
  record_type   TEXT DEFAULT 'V',
  approved      INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Customers
CREATE TABLE IF NOT EXISTS customers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  erp_customer_id   TEXT UNIQUE,
  legal_name        TEXT NOT NULL,
  name_1            TEXT,
  name_2            TEXT,
  name_3            TEXT,
  name_4            TEXT,
  trade_name        TEXT,
  customer_type     TEXT,  -- SOLD_TO | SHIP_TO | BILL_TO | PAYER | END_TO_END
  partner_function  TEXT,  -- SOLD_TO | SHIP_TO | BILL_TO | PAYER | END_TO_END
  customer_group    TEXT,
  market            TEXT,
  sales_region      TEXT,
  tax_category      TEXT,
  tax_id            TEXT,
  duns              TEXT,
  company_code      TEXT,
  sales_org         TEXT,
  distribution_ch   TEXT,
  division          TEXT,
  sales_area        TEXT,
  currency_code     TEXT,
  payment_terms     TEXT,
  credit_limit      REAL,
  incoterms         TEXT,
  industry          TEXT,
  region            TEXT,
  country           TEXT,
  postal_code       TEXT,
  status            TEXT DEFAULT 'PENDING',
  blocked_reason    TEXT,
  reactivation_mode TEXT,  -- TEMPORAL | PERMANENT
  gxp_flag          INTEGER DEFAULT 0,
  sox_flag          INTEGER DEFAULT 0,
  quality_class     TEXT,
  parent_id         INTEGER REFERENCES customers(id),
  contact_name      TEXT,
  contact_email     TEXT,
  contact_phone     TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customer_name ON customers(legal_name);
CREATE INDEX IF NOT EXISTS idx_customer_tax ON customers(tax_id);

-- Customer Addresses
CREATE TABLE IF NOT EXISTS customer_addresses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  address_type  TEXT NOT NULL,
  line1         TEXT, line2 TEXT,
  city TEXT, state TEXT, zip TEXT, country TEXT
);

-- Products (Material Master)
CREATE TABLE IF NOT EXISTS products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                TEXT UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT,
  product_type       TEXT,   -- FINISHED | RAW | SEMI | SERVICE | TRADING
  material_group     TEXT,
  base_uom           TEXT,
  gross_weight       REAL,
  net_weight         REAL,
  weight_uom         TEXT,
  volume             REAL,
  volume_uom         TEXT,
  hazardous          INTEGER DEFAULT 0,
  country_of_origin  TEXT,
  gtin               TEXT,
  hs_code            TEXT,
  lifecycle_status   TEXT DEFAULT 'PENDING',  -- PENDING | ACTIVE | OBSOLETE | BLOCKED
  division           TEXT,
  plant              TEXT,
  sales_org          TEXT,
  standard_cost      REAL,
  currency           TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT DEFAULT (datetime('now')),
  updated_at         TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_product_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_product_sku ON products(sku);

-- ---------- REQUESTS (Workflow Cases) ----------
CREATE TABLE IF NOT EXISTS requests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  wf_id             TEXT UNIQUE,      -- human readable e.g. VEN-000001
  domain            TEXT NOT NULL,    -- VENDOR | CUSTOMER | PRODUCT
  request_type      TEXT NOT NULL,    -- ONBOARDING | ADDRESS_UPDATE | ERP_UPDATE | TERMS_UPDATE | BANK_UPDATE | DEACTIVATION | REACTIVATION | ONE_TIME | CUSTOMER_UPDATE | COMPANY_CODE_EXT | SALES_AREA_EXT | PRODUCT_CREATE | PRODUCT_UPDATE
  subject_id        INTEGER,          -- id of vendor/customer/product being modified (null for new)
  payload           TEXT,             -- JSON payload of form data
  status            TEXT DEFAULT 'NEW',       -- NEW | WIP | PENDING_APPROVAL | AWAITING_INFO | ON_HOLD | COMPLETED | CANCELLED | REJECTED
  priority          TEXT DEFAULT 'NORMAL',    -- LOW | NORMAL | HIGH | CRITICAL
  risk              TEXT DEFAULT 'LOW',       -- LOW | MEDIUM | HIGH
  current_step      TEXT,
  current_assignee_role TEXT,
  current_assignee_id   INTEGER REFERENCES users(id),
  sla_due           TEXT,
  requestor_id      INTEGER REFERENCES users(id),
  requestor_name    TEXT,
  requestor_email   TEXT,
  requestor_region  TEXT,
  title             TEXT,
  short_description TEXT,
  created_at        TEXT DEFAULT (datetime('now')),
  updated_at        TEXT DEFAULT (datetime('now')),
  completed_at      TEXT,
  erp_response_status TEXT,
  erp_response_desc   TEXT,
  erp_supplier_id     TEXT
);
CREATE INDEX IF NOT EXISTS idx_req_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_req_domain ON requests(domain);
CREATE INDEX IF NOT EXISTS idx_req_assignee ON requests(current_assignee_role);

-- Workflow step history (audit trail)
CREATE TABLE IF NOT EXISTS workflow_steps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  step_name      TEXT NOT NULL,
  step_order     INTEGER,
  assignee_role  TEXT,
  assignee_id    INTEGER REFERENCES users(id),
  action         TEXT,      -- APPROVED | REJECTED | REQUESTED_INFO | SUBMITTED | COMPLETED | ASSIGNED
  comment        TEXT,
  reason_code    TEXT,       -- reason code selected on REJECT / REQUEST_INFO
  started_at     TEXT DEFAULT (datetime('now')),
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_ws_req ON workflow_steps(request_id);

-- Comments / Messages (in-app chat per request)
CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  author_name TEXT,
  body        TEXT,
  is_system   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Attachments (metadata only; files live in uploads_store)
CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER REFERENCES requests(id) ON DELETE CASCADE,
  doc_type    TEXT,    -- NDA | VMF | IRQ | W9 | MK_DENIALS | CPM17 | CODE_OF_CONDUCT | BANK_LETTER | OTHER
  filename    TEXT,
  mimetype    TEXT,
  size        INTEGER,
  stored_path TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT DEFAULT (datetime('now'))
);

-- Compliance checks snapshot per request
CREATE TABLE IF NOT EXISTS compliance_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  check_type  TEXT NOT NULL,  -- IRQ | VMF | NDA | MK_DENIAL | CPM17_COMPANY | CPM17_COMPLIANCE | CPM17_EHS | CPM17_GS110 | CODE_OF_CONDUCT | RAPID_RATINGS | ADVERSE_MEDIA | DUPLICATE_CHECK | DNB_VALIDATION
  performed_by TEXT,
  reviewed_by  TEXT,
  result       TEXT,   -- PASS | FAIL | REVIEW | MATCH | NO_MATCH
  notes        TEXT,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Notifications (in-app + email simulation)
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  request_id  INTEGER REFERENCES requests(id),
  subject     TEXT,
  body        TEXT,
  channel     TEXT DEFAULT 'INAPP', -- INAPP | EMAIL
  read_flag   INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_flag);

-- SLA Config per stage
CREATE TABLE IF NOT EXISTS sla_config (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  domain          TEXT,
  stage           TEXT,
  assignee_role   TEXT,
  sla_days        INTEGER,
  reminder_hours  INTEGER
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  entity     TEXT,
  entity_id  INTEGER,
  action     TEXT,
  diff       TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
