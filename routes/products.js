const express = require('express');
const db = require('../db/connection');
const wf = require('../lib/workflow');
const router = express.Router();

router.get('/', (req, res) => {
  const { q, status } = req.query;
  const clauses = []; const args = [];
  if (q) { clauses.push(`(name LIKE ? OR sku LIKE ? OR description LIKE ?)`); args.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (status) { clauses.push(`lifecycle_status=?`); args.push(status); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const products = db.prepare(`SELECT * FROM products ${where} ORDER BY name LIMIT 200`).all(...args);
  res.render('products/list', { products });
});

router.get('/:id', (req, res) => {
  const p = db.prepare(`SELECT * FROM products WHERE id=?`).get(req.params.id);
  if (!p) return res.status(404).render('error', { error: { message: 'Product not found' }});
  const history = db.prepare(`SELECT id, wf_id, request_type, status, created_at, completed_at
                              FROM requests WHERE domain='PRODUCT' AND subject_id=? ORDER BY id DESC`).all(p.id);
  res.render('products/detail', { product: p, history });
});

router.get('/new/create', (req, res) => {
  res.render('products/new_create', { ref: loadRef() });
});

router.post('/new/create', (req, res) => {
  const b = req.body;
  const r = wf.createRequest({
    domain: 'PRODUCT', requestType: 'PRODUCT_CREATE', subjectId: null,
    payload: b, requestor: res.locals.currentUser,
    title: `New Product: ${b.name}`,
    shortDesc: `${b.product_type || ''} / ${b.material_group || ''}`,
  });
  res.redirect(`/requests/${r.id}`);
});

router.get('/:id/update', (req, res) => {
  const p = db.prepare(`SELECT * FROM products WHERE id=?`).get(req.params.id);
  if (!p) return res.status(404).render('error', { error: { message: 'Product not found' }});
  res.render('products/update', { product: p, ref: loadRef() });
});

router.post('/:id/update', (req, res) => {
  const p = db.prepare(`SELECT * FROM products WHERE id=?`).get(req.params.id);
  if (!p) return res.status(404).render('error', { error: { message: 'Product not found' }});
  const r = wf.createRequest({
    domain: 'PRODUCT', requestType: 'PRODUCT_UPDATE', subjectId: p.id,
    payload: req.body, requestor: res.locals.currentUser,
    title: `Product Update — ${p.name}`,
    shortDesc: req.body.reason || '',
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
