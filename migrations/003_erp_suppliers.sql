-- migrations/003_erp_suppliers.sql
-- =============================================================================
-- ERP-side supplier master used for the duplicate-check feature on the vendor
-- onboarding form. Long-term this would be replaced with a live integration;
-- for now it's seeded with 20 well-known S&P 500 HQs + synthetic identifiers.
--
-- Tax IDs: 99-000000N (the 99- prefix is unused by the IRS — clearly fake).
-- DUNS:    9000000NN (nine digits, obviously synthetic).
--
-- Run with:
--   sqlite3 db/idot.sqlite < migrations/003_erp_suppliers.sql
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS erp_suppliers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  legal_name      TEXT NOT NULL,
  address_line1   TEXT,
  city            TEXT,
  state           TEXT,
  zip             TEXT,
  country         TEXT,
  tax_id          TEXT UNIQUE,
  duns            TEXT UNIQUE,
  erp_instance    TEXT,
  erp_supplier_id TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_erp_sup_name ON erp_suppliers(legal_name);
CREATE INDEX IF NOT EXISTS idx_erp_sup_tax  ON erp_suppliers(tax_id);
CREATE INDEX IF NOT EXISTS idx_erp_sup_duns ON erp_suppliers(duns);

INSERT OR IGNORE INTO erp_suppliers
  (legal_name, address_line1, city, state, zip, country, tax_id, duns, erp_instance, erp_supplier_id)
VALUES
  ('Apple Inc.',                       'One Apple Park Way',              'Cupertino',    'CA', '95014', 'United States', '99-0000001', '900000001', 'SAP:NA',   'V100001'),
  ('Microsoft Corporation',            'One Microsoft Way',               'Redmond',      'WA', '98052', 'United States', '99-0000002', '900000002', 'SAP:NA',   'V100002'),
  ('Amazon.com, Inc.',                 '410 Terry Avenue North',          'Seattle',      'WA', '98109', 'United States', '99-0000003', '900000003', 'SAP:NA',   'V100003'),
  ('Alphabet Inc.',                    '1600 Amphitheatre Parkway',       'Mountain View','CA', '94043', 'United States', '99-0000004', '900000004', 'JDE:NA',   'V100004'),
  ('Meta Platforms, Inc.',             '1 Hacker Way',                    'Menlo Park',   'CA', '94025', 'United States', '99-0000005', '900000005', 'SAP:NA',   'V100005'),
  ('Tesla, Inc.',                      '1 Tesla Road',                    'Austin',       'TX', '78725', 'United States', '99-0000006', '900000006', 'SAP:NA',   'V100006'),
  ('Berkshire Hathaway Inc.',          '3555 Farnam Street',              'Omaha',        'NE', '68131', 'United States', '99-0000007', '900000007', 'JDE:NA',   'V100007'),
  ('JPMorgan Chase & Co.',             '383 Madison Avenue',              'New York',     'NY', '10179', 'United States', '99-0000008', '900000008', 'SAP:NA',   'V100008'),
  ('Johnson & Johnson',                'One Johnson & Johnson Plaza',     'New Brunswick','NJ', '08933', 'United States', '99-0000009', '900000009', 'SAP:NA',   'V100009'),
  ('Visa Inc.',                        '900 Metro Center Boulevard',      'Foster City',  'CA', '94404', 'United States', '99-0000010', '900000010', 'SAP:NA',   'V100010'),
  ('The Procter & Gamble Company',     '1 Procter & Gamble Plaza',        'Cincinnati',   'OH', '45202', 'United States', '99-0000011', '900000011', 'SAP:NA',   'V100011'),
  ('Walmart Inc.',                     '702 SW 8th Street',               'Bentonville',  'AR', '72716', 'United States', '99-0000012', '900000012', 'SAP:NA',   'V100012'),
  ('UnitedHealth Group Incorporated',  '9900 Bren Road East',             'Minnetonka',   'MN', '55343', 'United States', '99-0000013', '900000013', 'JDE:NA',   'V100013'),
  ('Exxon Mobil Corporation',          '22777 Springwoods Village Pkwy',  'Spring',       'TX', '77389', 'United States', '99-0000014', '900000014', 'SAP:NA',   'V100014'),
  ('Mastercard Incorporated',          '2000 Purchase Street',            'Purchase',     'NY', '10577', 'United States', '99-0000015', '900000015', 'SAP:NA',   'V100015'),
  ('The Home Depot, Inc.',             '2455 Paces Ferry Road NW',        'Atlanta',      'GA', '30339', 'United States', '99-0000016', '900000016', 'JDE:NA',   'V100016'),
  ('Chevron Corporation',              '6001 Bollinger Canyon Road',      'San Ramon',    'CA', '94583', 'United States', '99-0000017', '900000017', 'SAP:NA',   'V100017'),
  ('The Coca-Cola Company',            'One Coca-Cola Plaza',             'Atlanta',      'GA', '30313', 'United States', '99-0000018', '900000018', 'SAP:NA',   'V100018'),
  ('PepsiCo, Inc.',                    '700 Anderson Hill Road',          'Purchase',     'NY', '10577', 'United States', '99-0000019', '900000019', 'SAP:NA',   'V100019'),
  ('Bank of America Corporation',      '100 North Tryon Street',          'Charlotte',    'NC', '28255', 'United States', '99-0000020', '900000020', 'SAP:NA',   'V100020');

COMMIT;
