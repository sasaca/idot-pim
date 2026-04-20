const express = require('express');
const db = require('../db/connection');
const wf = require('../lib/workflow');
const router = express.Router();

// SOX-sensitive field list mirrors lib/workflow.js
const SOX_FIELDS = ['tax_id','credit_limit','payment_terms','bank_account','iban','legal_name','name_1','name_2','name_3','name_4'];

router.get('/', (req, res) => {
  const { q, status } = req.query;
  const clauses = []; const args = [];
  if (q) { clauses.push(`(legal_name LIKE ? OR tax_id LIKE ? OR erp_customer_id LIKE ?)`); args.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (status) { clauses.push(`status=?`); args.push(status); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const customers = db.prepare(`SELECT * FROM customers ${where} ORDER BY legal_name LIMIT 200`).all(...args);
  res.render('customers/list', { customers });
});

// ---- NEW-REQUEST FLOWS ----
router.get('/new/onboarding', (req, res) => {
  res.render('customers/new_onboarding', { ref: loadRef() });
});

router.post('/new/onboarding', (req, res) => {
  const b = req.body;
  const r = wf.createRequest({
    domain: 'CUSTOMER', requestType: 'ONBOARDING', subjectId: null,
    payload: b, requestor: res.locals.currentUser,
    title: `New Customer: ${b.legal_name || b.pf_END_name_1 || b.pf_SP_name_1 || '(no name)'}`,
    shortDesc: `${b.customer_type || ''} / ${b.country || ''} / PF=${b.partner_function || 'END_TO_END'}`,
  });
  res.redirect(`/requests/${r.id}`);
});

// ---- DETAIL ----
router.get('/:id', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  const history = db.prepare(`SELECT id, wf_id, request_type, status, created_at, completed_at
                              FROM requests WHERE domain='CUSTOMER' AND subject_id=? ORDER BY id DESC`).all(c.id);
  res.render('customers/detail', { customer: c, history });
});

// ---- BLOCK ----
router.get('/:id/block', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  res.render('customers/block', { customer: c, ref: loadRef() });
});
router.post('/:id/block', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  const r = wf.createRequest({
    domain: 'CUSTOMER', requestType: 'CUSTOMER_BLOCK', subjectId: c.id,
    payload: { ...req.body, country: c.country, partner_function: c.partner_function },
    requestor: res.locals.currentUser,
    title: `Block: ${c.legal_name}`,
    shortDesc: req.body.blocked_reason || 'Customer block',
    priority: 'HIGH',
  });
  res.redirect(`/requests/${r.id}`);
});

// ---- REACTIVATE ----
router.get('/:id/reactivate', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  res.render('customers/reactivate', { customer: c, ref: loadRef() });
});
router.post('/:id/reactivate', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  const r = wf.createRequest({
    domain: 'CUSTOMER', requestType: 'CUSTOMER_REACTIVATION', subjectId: c.id,
    payload: { ...req.body, country: c.country, partner_function: c.partner_function },
    requestor: res.locals.currentUser,
    title: `Reactivate (${(req.body.reactivation_mode || '').toLowerCase()}): ${c.legal_name}`,
    shortDesc: req.body.reason || '',
  });
  res.redirect(`/requests/${r.id}`);
});

// ---- MODIFY (generic modification, driven by change_type) ----
router.get('/:id/modify', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  res.render('customers/modify', { customer: c, ref: loadRef() });
});
router.post('/:id/modify', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  const b = req.body;
  // Compute which fields changed (for SOX detection + audit)
  const changed = [];
  for (const k of Object.keys(b)) {
    if (k === 'change_type' || k === 'reason') continue;
    const newVal = (b[k] ?? '').toString();
    const oldVal = (c[k] ?? '').toString();
    if (newVal && newVal !== oldVal) changed.push(k);
  }
  const payload = { ...b, changed_fields: changed, country: b.country || c.country, partner_function: c.partner_function };
  const r = wf.createRequest({
    domain: 'CUSTOMER', requestType: 'CUSTOMER_UPDATE', subjectId: c.id,
    payload, requestor: res.locals.currentUser,
    title: `Modify (${b.change_type || 'GENERAL'}): ${c.legal_name}`,
    shortDesc: b.reason || '',
    risk: changed.some(f => SOX_FIELDS.includes(f)) ? 'MEDIUM' : 'LOW',
  });
  res.redirect(`/requests/${r.id}`);
});

// ---- LEGACY UPDATE (still supported for company-code / sales-area extensions) ----
router.get('/:id/update/:kind', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  res.render('customers/update', { customer: c, kind: req.params.kind, ref: loadRef() });
});
router.post('/:id/update/:kind', (req, res) => {
  const c = db.prepare(`SELECT * FROM customers WHERE id=?`).get(req.params.id);
  if (!c) return res.status(404).render('error', { error: { message: 'Customer not found' }});
  const typeMap = {
    general: 'CUSTOMER_UPDATE', 'all-fields': 'CUSTOMER_UPDATE',
    'company-code': 'COMPANY_CODE_EXT', 'sales-area': 'SALES_AREA_EXT',
  };
  const requestType = typeMap[req.params.kind] || 'CUSTOMER_UPDATE';
  const b = req.body;
  const changed = [];
  for (const k of Object.keys(b)) {
    if (k === 'reason') continue;
    const newVal = (b[k] ?? '').toString();
    const oldVal = (c[k] ?? '').toString();
    if (newVal && newVal !== oldVal) changed.push(k);
  }
  const payload = { ...b, changed_fields: changed, country: c.country, partner_function: c.partner_function, change_type: req.params.kind === 'general' ? 'PAYMENT_TERMS' : undefined };
  const r = wf.createRequest({
    domain: 'CUSTOMER', requestType, subjectId: c.id,
    payload, requestor: res.locals.currentUser,
    title: `${requestType} — ${c.legal_name}`,
    shortDesc: b.reason || '',
  });
  res.redirect(`/requests/${r.id}`);
});

function loadRef() {
  const byCat = {};
  db.prepare(`SELECT * FROM reference_data WHERE active=1 ORDER BY label`).all().forEach(r => {
    (byCat[r.category] = byCat[r.category] || []).push(r);
  });
  return byCat;
}

module.exports = router;
