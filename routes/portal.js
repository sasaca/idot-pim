// Supplier / Customer self-service portal — external-facing tasks assigned to them
const express = require('express');
const db = require('../db/connection');
const wf = require('../lib/workflow');
const router = express.Router();

router.get('/', (req, res) => {
  const u = res.locals.currentUser;
  // Tasks for SUPPLIER / CUSTOMER assigned to their role
  const tasks = db.prepare(`SELECT * FROM requests WHERE current_assignee_role=? ORDER BY id DESC LIMIT 50`).all(u.role);
  res.render('portal/home', { tasks });
});

router.get('/tasks/:id', (req, res) => {
  const request = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!request) return res.status(404).render('error', { error: { message: 'Task not found' }});
  request.payloadObj = (() => { try { return JSON.parse(request.payload || '{}'); } catch { return {}; } })();
  res.render('portal/task', { request });
});

router.post('/tasks/:id/submit', (req, res) => {
  // Supplier submits banking / remit-to / manufacturing form (or customer completes their submission)
  const b = req.body;
  const request = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!request) return res.status(404).render('error', { error: { message: 'Task not found' }});
  const payload = (() => { try { return JSON.parse(request.payload || '{}'); } catch { return {}; } })();
  payload.supplier_portion = {
    payment_instrument: b.payment_instrument, additional_tax_id: b.additional_tax_id,
    bank: { bank_name: b.bank_name, bank_account: b.bank_account, bank_transit: b.bank_transit,
            iban: b.iban, swift: b.swift, bank_country: b.bank_country },
    remit_to: { country: b.remit_country, state: b.remit_state, address: b.remit_address,
                zip: b.remit_zip, email: b.remit_email, po_email: b.po_email },
    manufacturing: { address: b.mfg_address, city: b.mfg_city, state: b.mfg_state,
                     zip: b.mfg_zip, country: b.mfg_country },
    code_of_conduct: b.code_of_conduct === 'on',
    privacy_ack: b.privacy_ack === 'on',
    cpm17: b.cpm17 === 'on',
  };
  db.prepare(`UPDATE requests SET payload=? WHERE id=?`).run(JSON.stringify(payload), request.id);
  wf.advanceRequest(request.id, 'SUBMITTED', res.locals.currentUser, 'Supplier completed self-service form');
  res.redirect('/portal');
});

module.exports = router;
