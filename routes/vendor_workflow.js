// routes/vendor_workflow.js
// -----------------------------------------------------------------------------
// Vendor onboarding workflow routes.
//
// Mount at /vendors/:id/workflow (see INSTALL.md). This router exposes the
// Supply Chain review, Supplier, Vendor Admin, and Legal forms, plus the
// final confirmation page and a role-based queue.
//
// The route handlers render scaffolded EJS views under views/vendors/. Field
// contents will be filled in later — these stubs keep the workflow plumbing,
// state machine, role gating, and navigation correct.
// -----------------------------------------------------------------------------

const express = require('express');

const workflow = require('../lib/vendor_workflow');
const workflowConfig = require('../lib/workflow_config');
const {
  requireRole,
  requireState,
  loadVendor,
  getUserRoles,
} = require('../middleware/require_role');

// Given a vendor's enabled_stages (JSON array) and a proposed next state from
// the default state machine, return the actual next state. Skips any stage
// that has been disabled by the admin-configured workflow rules.
function resolveNextState(vendor, fromState, proposedNext) {
  // Terminal states always take precedence.
  if (proposedNext === workflow.STATES.CONFIRMED || proposedNext === workflow.STATES.REJECTED) {
    return proposedNext;
  }
  let enabled;
  try { enabled = JSON.parse(vendor.enabled_stages || '[]'); } catch { enabled = []; }
  // If no config was recorded on this vendor, fall back to the state-machine default.
  if (!Array.isArray(enabled) || enabled.length === 0) return proposedNext;
  if (enabled.includes(proposedNext)) return proposedNext;
  // Skip forward through the default catalog order, past the disabled stage,
  // until we find an enabled one. If none remain, the workflow is complete.
  const catalogOrder = workflowConfig.STAGE_CATALOG.map((s) => s.stage);
  const startIdx = catalogOrder.indexOf(proposedNext);
  if (startIdx < 0) return proposedNext;
  for (let i = startIdx + 1; i < catalogOrder.length; i++) {
    if (enabled.includes(catalogOrder[i])) return catalogOrder[i];
  }
  return workflow.STATES.CONFIRMED;
}

/**
 * Build a router. Pass in the shared better-sqlite3 db handle so the router
 * can persist state transitions without requiring a global.
 *
 *   const vendorWorkflow = require('./routes/vendor_workflow')(db);
 *   app.use('/vendors/:id/workflow', vendorWorkflow);
 */
module.exports = function makeRouter(db) {
  const router = express.Router({ mergeParams: true });

  // Parse form-encoded POST bodies (used by each review/submit endpoint).
  router.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Every request under this router loads the vendor first so requireState()
  // can inspect it.
  router.use(loadVendor(db));

  // ------------------------------------------------------------------ helpers
  // Persist a state transition plus history + optional comment, atomically.
  const applyTransition = db.transaction((vendorId, result, userId, userRole, note) => {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE vendors
         SET workflow_state = ?,
             workflow_updated_at = ?,
             workflow_updated_by = ?
       WHERE id = ?
    `).run(result.nextState, now, userId || null, vendorId);

    db.prepare(`
      INSERT INTO vendor_workflow_history
        (vendor_id, action, from_state, to_state, actor_user_id, actor_role, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      vendorId,
      result.action,
      result.fromState,
      result.nextState,
      userId || null,
      userRole || null,
      note || null
    );

    if (note && note.trim()) {
      db.prepare(`
        INSERT INTO vendor_workflow_comments
          (vendor_id, author_user_id, author_role, stage, body)
        VALUES (?, ?, ?, ?, ?)
      `).run(vendorId, userId || null, userRole || null, result.nextState, note.trim());
    }
  });

  // Wrap workflow.transition() to also thread the `action` and `fromState`
  // through for the audit row.
  function doTransition(action, req, res) {
    const vendor = res.locals.vendor;
    const userRoles = getUserRoles(req);
    const primaryRole = userRoles[0] || null;

    // Try each of the user's roles until one permits the transition.
    let result = null;
    for (const role of userRoles) {
      const r = workflow.transition(action, vendor.workflow_state, role);
      if (r.ok) { result = { ...r, action, fromState: vendor.workflow_state, role }; break; }
    }
    if (!result) {
      return res.status(403).json({ error: 'FORBIDDEN_OR_ILLEGAL', action });
    }

    // Admin workflow-config override: skip any stage the admin has disabled
    // (or whose triggers didn't match) for this vendor.
    result.nextState = resolveNextState(vendor, vendor.workflow_state, result.nextState);

    const note = String(req.body.comment || req.body.note || '').slice(0, 4000);
    applyTransition(vendor.id, result, req.user && req.user.id, result.role || primaryRole, note);

    // Redirect to the next logical view.
    const nextUrl = workflow.viewFor(result.nextState, vendor.id);
    return res.redirect(nextUrl || `/vendors/${vendor.id}/workflow/confirmation`);
  }

  function renderForm(view, req, res) {
    const vendor = res.locals.vendor;
    const history = db.prepare(`
      SELECT * FROM vendor_workflow_history WHERE vendor_id = ? ORDER BY id ASC
    `).all(vendor.id);
    const comments = db.prepare(`
      SELECT * FROM vendor_workflow_comments WHERE vendor_id = ? ORDER BY id ASC
    `).all(vendor.id);
    const actions = workflow.availableActions(
      vendor.workflow_state,
      getUserRoles(req)[0]  // just show the primary role's actions
    );
    res.render(view, {
      vendor,
      workflow,
      history,
      comments,
      actions,
      stateLabel: workflow.stateLabel(vendor.workflow_state),
      user: req.user || null,
    });
  }

  // ============================================================== 1) Supply Chain
  router.get(
    '/supply-chain-review',
    requireRole(workflow.ROLES.SUPPLY_CHAIN),
    requireState(workflow.STATES.PENDING_SC_REVIEW),
    (req, res) => renderForm('vendors/workflow_supply_chain', req, res)
  );

  router.post(
    '/supply-chain-decision',
    requireRole(workflow.ROLES.SUPPLY_CHAIN),
    requireState(workflow.STATES.PENDING_SC_REVIEW),
    (req, res) => {
      const decision = String(req.body.decision || '').toLowerCase();
      const map = {
        approve:      'sc_approve',
        reject:       'sc_reject',
        request_info: 'sc_request_info',
        'needs-info': 'sc_request_info',
      };
      const action = map[decision];
      if (!action) return res.status(400).json({ error: 'BAD_DECISION', got: decision });
      return doTransition(action, req, res);
    }
  );

  // ============================================================== 2) Supplier
  router.get(
    '/supplier',
    requireRole(workflow.ROLES.SUPPLIER),
    requireState(workflow.STATES.PENDING_SUPPLIER),
    (req, res) => renderForm('vendors/workflow_supplier', req, res)
  );

  router.post(
    '/supplier',
    requireRole(workflow.ROLES.SUPPLIER),
    requireState(workflow.STATES.PENDING_SUPPLIER),
    (req, res) => doTransition('supplier_submit', req, res)
  );

  // ============================================================== 3) Vendor Admin
  router.get(
    '/vendor-admin',
    requireRole(workflow.ROLES.VENDOR_ADMIN),
    requireState(workflow.STATES.PENDING_VENDOR_ADMIN),
    (req, res) => renderForm('vendors/workflow_vendor_admin', req, res)
  );

  router.post(
    '/vendor-admin',
    requireRole(workflow.ROLES.VENDOR_ADMIN),
    requireState(workflow.STATES.PENDING_VENDOR_ADMIN),
    (req, res) => doTransition('vendor_admin_submit', req, res)
  );

  // ============================================================== 4) Legal
  router.get(
    '/legal',
    requireRole(workflow.ROLES.LEGAL),
    requireState(workflow.STATES.PENDING_LEGAL),
    (req, res) => renderForm('vendors/workflow_legal', req, res)
  );

  router.post(
    '/legal-decision',
    requireRole(workflow.ROLES.LEGAL),
    requireState(workflow.STATES.PENDING_LEGAL),
    (req, res) => {
      const decision = String(req.body.decision || '').toLowerCase();
      const action = decision === 'approve' ? 'legal_approve'
                   : decision === 'reject'  ? 'legal_reject'
                   : null;
      if (!action) return res.status(400).json({ error: 'BAD_DECISION', got: decision });
      return doTransition(action, req, res);
    }
  );

  // ============================================================== 5) Confirmation
  // Public to any authenticated user who can see the vendor.
  router.get(
    '/confirmation',
    (req, res) => renderForm('vendors/workflow_confirmation', req, res)
  );

  // ============================================================== 6) Resubmit (NEEDS_INFO -> PENDING_SC_REVIEW)
  router.post(
    '/resubmit',
    requireState(workflow.STATES.NEEDS_INFO),
    (req, res) => doTransition('resubmit', req, res)
  );

  return router;
};

// -----------------------------------------------------------------------------
// Queue router: one page per role listing "everything waiting for you".
// Mount separately at /vendors/queue (no :id).
//
//   const { makeQueueRouter } = require('./routes/vendor_workflow');
//   app.use('/vendors/queue', makeQueueRouter(db));
// -----------------------------------------------------------------------------
module.exports.makeQueueRouter = function makeQueueRouter(db) {
  const router = express.Router();
  const { ROLES, STATES, STATE_OWNER, stateLabel } = workflow;

  router.get('/', requireRole(
    ROLES.SUPPLY_CHAIN, ROLES.SUPPLIER, ROLES.VENDOR_ADMIN, ROLES.LEGAL, ROLES.REQUESTOR
  ), (req, res) => {
    const roles = getUserRoles(req);
    // Map each of my roles to the states that sit in my queue.
    const myStates = new Set();
    for (const role of roles) {
      for (const [state, owner] of Object.entries(STATE_OWNER)) {
        if (owner === role) myStates.add(state);
      }
    }
    if (myStates.size === 0) {
      return res.render('vendors/workflow_queue', { vendors: [], roles, stateLabel });
    }
    const placeholders = Array.from(myStates).map(() => '?').join(',');
    const vendors = db.prepare(
      `SELECT id, legal_name, workflow_state, workflow_updated_at
         FROM vendors
        WHERE workflow_state IN (${placeholders})
        ORDER BY workflow_updated_at DESC, id DESC
        LIMIT 200`
    ).all(...Array.from(myStates));
    res.render('vendors/workflow_queue', { vendors, roles, stateLabel });
  });

  return router;
};
