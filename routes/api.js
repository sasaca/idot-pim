// Public-style JSON endpoints used by the UI (search, duplicate check, ref lookups)
const express = require('express');
const db = require('../db/connection');
const { dupCheckVendor, mkDenialCheck } = require('../lib/duplicate');
const router = express.Router();

router.get('/search/vendors', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = db.prepare(`SELECT id, erp_supplier_id, legal_name, tax_id, duns, status
                           FROM vendors WHERE legal_name LIKE ? OR tax_id LIKE ? OR duns LIKE ?
                           LIMIT 10`).all(q, q, q);
  res.json(rows);
});

router.get('/search/customers', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = db.prepare(`SELECT id, erp_customer_id, legal_name, tax_id, status
                           FROM customers WHERE legal_name LIKE ? OR tax_id LIKE ? LIMIT 10`).all(q, q);
  res.json(rows);
});

router.get('/search/products', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  const rows = db.prepare(`SELECT id, sku, name, product_type, lifecycle_status
                           FROM products WHERE name LIKE ? OR sku LIKE ? LIMIT 10`).all(q, q);
  res.json(rows);
});

router.post('/duplicate-check', (req, res) => {
  res.json(dupCheckVendor(req.body || {}));
});

router.post('/mk-denial', (req, res) => {
  res.json(mkDenialCheck(req.body?.legal_name || ''));
});

router.get('/reference/:category', (req, res) => {
  const rows = db.prepare(`SELECT code, label, parent FROM reference_data
                           WHERE category=? AND active=1 ORDER BY label`).all(req.params.category);
  res.json(rows);
});

module.exports = router;
