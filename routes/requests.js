const express = require('express');
const db = require('../db/connection');
const wf = require('../lib/workflow');
const vendorWorkflow = require('../lib/vendor_workflow');
const router = express.Router();

// List all requests w/ filters. Also surfaces vendor onboarding workflow
// items in the current user's queue (PENDING_SC_REVIEW for Supply Chain,
// PENDING_SUPPLIER for the supplier, etc.) so role-holders find their
// pending work where they expect it.
router.get('/', (req, res) => {
  const { domain, status, mine, q } = req.query;
  const clauses = []; const args = [];
  if (domain) { clauses.push(`domain=?`); args.push(domain); }
  if (status) { clauses.push(`status=?`); args.push(status); }
  if (mine === '1') { clauses.push(`(requestor_id=? OR current_assignee_role=?)`); args.push(res.locals.currentUser.id, res.locals.currentUser.role); }
  if (q) { clauses.push(`(wf_id LIKE ? OR title LIKE ? OR short_description LIKE ?)`); args.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM requests ${where} ORDER BY id DESC LIMIT 200`).all(...args);

  // Vendor workflow items relevant to this user.
  const userRole = res.locals.currentUser.role;
  const ownedStates = Object.entries(vendorWorkflow.STATE_OWNER)
    .filter(([, owner]) => owner === userRole)
    .map(([state]) => state);
  let vendorWf = [];
  if (userRole === 'MASTER_ADMIN') {
    vendorWf = db.prepare(`
      SELECT id, legal_name, workflow_state, workflow_updated_at, created_by
        FROM vendors
       WHERE workflow_state NOT IN ('CONFIRMED','REJECTED','DRAFT')
       ORDER BY workflow_updated_at DESC, id DESC
       LIMIT 200
    `).all();
  } else if (ownedStates.length) {
    const placeholders = ownedStates.map(() => '?').join(',');
    vendorWf = db.prepare(`
      SELECT id, legal_name, workflow_state, workflow_updated_at, created_by
        FROM vendors
       WHERE workflow_state IN (${placeholders})
       ORDER BY workflow_updated_at DESC, id DESC
       LIMIT 200
    `).all(...ownedStates);
  }
  // Decorate with the URL the role should land on for this stage.
  vendorWf = vendorWf.map((v) => ({
    ...v,
    state_label: vendorWorkflow.stateLabel(v.workflow_state),
    open_url:    vendorWorkflow.viewFor(v.workflow_state, v.id) || `/vendors/${v.id}`,
  }));

  res.render('requests/list', { rows, vendorWf });
});

// Request detail
router.get('/:id', (req, res) => {
  const request = db.prepare(`SELECT * FROM requests WHERE id=?`).get(req.params.id);
  if (!request) return res.status(404).render('error', { error: { message: 'Request not found' } });
  request.payloadObj = (() => { try { return JSON.parse(request.payload || '{}'); } catch { return {}; } })();

  const steps = db.prepare(`SELECT ws.*, u.name as user_name FROM workflow_steps ws
    LEFT JOIN users u ON u.id = ws.assignee_id WHERE request_id=? ORDER BY id ASC`).all(req.params.id);
  const comments = db.prepare(`SELECT * FROM comments WHERE request_id=? ORDER BY id ASC`).all(req.params.id);
  const attachments = db.prepare(`SELECT * FROM attachments WHERE request_id=? ORDER BY id DESC`).all(req.params.id);
  const compliance = db.prepare(`SELECT * FROM compliance_checks WHERE request_id=? ORDER BY id ASC`).all(req.params.id);
  // Context-aware flow (filters conditional steps based on payload: LATAM, EU, SOX, etc.)
  const payloadObj = request.payloadObj;
  const flow = (wf.getActiveFlow
    ? wf.getActiveFlow(request.domain, request.request_type, { payload: payloadObj })
    : wf.stepsFor(request.domain, request.request_type));

  // Subject record preview
  let subject = null;
  if (request.subject_id) {
    if (request.domain === 'VENDOR') subject = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(request.subject_id);
    if (request.domain === 'CUSTOMER') subject = db.prepare(`SELECT * FROM customers WHERE id=?`).get(request.subject_id);
    if (request.domain === 'PRODUCT') subject = db.prepare(`SELECT * FROM products WHERE id=?`).get(request.subject_id);
  }

  const canAct = res.locals.currentUser.role === request.current_assignee_role
    && ['NEW','WIP','PENDING_APPROVAL','AWAITING_INFO'].includes(request.status);

  const reasonCodes = wf.REASON_CODES || { REJECT: [], REQUEST_INFO: [] };

  res.render('requests/detail', { request, steps, comments, attachments, compliance, flow, subject, canAct, reasonCodes });
});

// Action: approve / reject / request info
router.post('/:id/action', (req, res) => {
  const { action, comment, reason_code_reject, reason_code_info } = req.body;
  const map = { approve: 'APPROVED', reject: 'REJECTED', info: 'REQUESTED_INFO', submit: 'SUBMITTED' };
  const a = map[action];
  if (!a) return res.status(400).send('Unknown action');
  // Pick the reason code from the matching dropdown
  let reasonCode = null;
  if (action === 'reject') reasonCode = reason_code_reject || null;
  else if (action === 'info') reasonCode = reason_code_info || null;
  try {
    wf.advanceRequest(Number(req.params.id), a, res.locals.currentUser, comment || '', reasonCode);
  } catch (e) {
    return res.status(400).render('error', { error: { message: e.message } });
  }
  res.redirect(`/requests/${req.params.id}`);
});

// Comment
router.post('/:id/comment', (req, res) => {
  db.prepare(`INSERT INTO comments (request_id,user_id,author_name,body) VALUES (?,?,?,?)`)
    .run(req.params.id, res.locals.currentUser.id, res.locals.currentUser.name, req.body.body || '');
  res.redirect(`/requests/${req.params.id}`);
});

// Cancel
router.post('/:id/cancel', (req, res) => {
  db.prepare(`UPDATE requests SET status='CANCELLED', updated_at=datetime('now') WHERE id=? AND requestor_id=?`)
    .run(req.params.id, res.locals.currentUser.id);
  res.redirect(`/requests/${req.params.id}`);
});

module.exports = router;
