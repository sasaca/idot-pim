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
const path = require('path');
const multer = require('multer');

const workflow = require('../lib/vendor_workflow');
const workflowConfig = require('../lib/workflow_config');

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads_store');
const uploadLegal = multer({ dest: uploadDir });
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

    // Redirect to the workflow status page. Sending the user to the *next*
    // stage's form (workflow.viewFor) used to bounce them onto a page their
    // role can't open (e.g. the SC reviewer landing on /supplier → 403).
    // The /confirmation page is unguarded by role and shows the current
    // status to whoever just submitted — it tells them their action was
    // recorded and which stage now owns the work.
    return res.redirect(`/vendors/${vendor.id}/workflow/confirmation?from=${encodeURIComponent(result.action)}`);
  }

  function renderForm(view, req, res) {
    const vendor = res.locals.vendor;
    const history = db.prepare(`
      SELECT * FROM vendor_workflow_history WHERE vendor_id = ? ORDER BY id ASC
    `).all(vendor.id);
    const comments = db.prepare(`
      SELECT * FROM vendor_workflow_comments WHERE vendor_id = ? ORDER BY id ASC
    `).all(vendor.id);
    const addresses = db.prepare(
      `SELECT * FROM vendor_addresses WHERE vendor_id = ?`
    ).all(vendor.id);
    const banks = db.prepare(
      `SELECT * FROM vendor_banks WHERE vendor_id = ?`
    ).all(vendor.id);
    const attachments = db.prepare(
      `SELECT id, stage, filename, mimetype, size, uploaded_at
         FROM vendor_attachments WHERE vendor_id = ? ORDER BY id DESC`
    ).all(vendor.id);
    const actions = workflow.availableActions(
      vendor.workflow_state,
      getUserRoles(req)[0]  // just show the primary role's actions
    );
    res.render(view, {
      vendor,
      workflow,
      history,
      comments,
      addresses,
      banks,
      attachments,
      actions,
      stateLabel: workflow.stateLabel(vendor.workflow_state),
      user: req.user || null,
    });
  }

  // Persist everything the Vendor Admin can touch — including fixes to the
  // Requestor and Supplier data — then the caller transitions to PENDING_LEGAL.
  const persistVendorAdminData = db.transaction((vendor, b) => {
    // 1) Identity + configuration columns on vendors. Identity fields
    //    (legal_name, tax_id, duns) are never blanked — use COALESCE/NULLIF.
    const ynToInt = (v) => v === 'Yes' ? 1 : v === 'No' ? 0 : null;
    db.prepare(`
      UPDATE vendors SET
        legal_name            = COALESCE(NULLIF(?, ''), legal_name),
        secondary_alpha_name  = ?,
        tax_id                = COALESCE(NULLIF(?, ''), tax_id),
        duns                  = COALESCE(NULLIF(?, ''), duns),
        additional_tax_id     = ?,
        category_l1           = ?,
        category_l2           = ?,
        commodity_code        = ?,
        erp_instance          = ?,
        line_of_business      = ?,
        currency_code         = ?,
        ap_payment_terms      = ?,
        high_level_class      = ?,
        primary_contact_name  = ?,
        primary_contact_email = ?,
        primary_contact_phone = ?,
        payment_instrument    = ?,
        ap_gl_class           = ?,
        tax_rate_area         = ?,
        tax_explanation_code  = ?,
        address_type_payables = ?,
        reporting_code        = ?,
        hold_payment_code     = ?,
        hold_order_code       = ?,
        person_corp_code      = ?,
        financial_soundness_verified = ?,
        mk_denial_verified    = ?,
        updated_at            = ?
      WHERE id = ?
    `).run(
      b.legal_name, b.secondary_alpha_name, b.tax_id, b.duns, b.additional_tax_id,
      b.category_l1, b.category_l2, b.commodity_code, b.erp_instance, b.line_of_business,
      b.currency_code, b.ap_payment_terms, b.high_level_class,
      b.primary_contact_name, b.primary_contact_email, b.primary_contact_phone,
      b.payment_instrument, b.ap_gl_class, b.tax_rate_area, b.tax_explanation_code,
      b.address_type_payables, b.reporting_code, b.hold_payment_code, b.hold_order_code,
      b.person_corp_code,
      ynToInt(b.financial_soundness_verified),
      ynToInt(b.mk_denial_verified),
      new Date().toISOString(),
      vendor.id
    );

    // 2) Bank — authoritative, one row per vendor.
    db.prepare(`DELETE FROM vendor_banks WHERE vendor_id = ?`).run(vendor.id);
    if (b.bank_name || b.bank_account) {
      db.prepare(`
        INSERT INTO vendor_banks
          (vendor_id, bank_name, bank_account, bank_transit, iban, swift, bank_country, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(vendor.id, b.bank_name, b.bank_account, b.bank_transit, b.iban, b.swift, b.bank_country);
    }

    // 3) Addresses — upsert PRIMARY / REMIT_TO / MANUFACTURING only if provided.
    const replaceAddr = (type, row) => {
      db.prepare(`DELETE FROM vendor_addresses WHERE vendor_id=? AND address_type=?`).run(vendor.id, type);
      db.prepare(`
        INSERT INTO vendor_addresses
          (vendor_id, address_type, line1, line2, line3, line4, city, state, zip, country)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vendor.id, type,
        row.line1 || null, row.line2 || null, row.line3 || null, row.line4 || null,
        row.city || null, row.state || null, row.zip || null, row.country || null);
    };
    if (b.addr_line1 || b.addr_city || b.addr_country || b.addr_zip) {
      replaceAddr('PRIMARY', {
        line1: b.addr_line1, line2: b.addr_line2, line3: b.addr_line3, line4: b.addr_line4,
        city: b.addr_city, state: b.addr_state, zip: b.addr_zip, country: b.addr_country,
      });
    }
    if (b.remit_to_country || b.remit_to_city || b.remit_to_address) {
      replaceAddr('REMIT_TO', {
        line1: b.remit_to_address, city: b.remit_to_city, state: b.remit_to_state,
        zip: b.remit_to_zip, country: b.remit_to_country,
      });
    }
    if (b.mfg_country || b.mfg_city || b.mfg_address) {
      replaceAddr('MANUFACTURING', {
        line1: b.mfg_address, city: b.mfg_city, state: b.mfg_state,
        zip: b.mfg_zip, country: b.mfg_country,
      });
    }

    // 4) extra_fields.vendor_admin — the fields without a dedicated column.
    let extra = {};
    try { extra = JSON.parse(vendor.extra_fields || '{}'); } catch {}
    extra.vendor_admin = {
      factory_special_payee:     b.factory_special_payee || null,
      tax_authority_withholding: b.tax_authority_withholding || null,
      withholding_percent:       b.withholding_percent || null,
      classification_code_01:    b.classification_code_01 || null,
      sampling_percent:          b.sampling_percent || null,
      ims_prefix_code:           b.ims_prefix_code || null,
      ims_site_code:             b.ims_site_code || null,
      default_expense_type:      b.default_expense_type || null,
      evaluated_receipts:        b.evaluated_receipts || null,
      submitted_at:              new Date().toISOString(),
    };
    for (const n of [11, 14, 15, 16, 17, 18, 19, 21, 24]) {
      const key = `address_book_category_code_${n}`;
      if (b[key]) extra.vendor_admin[key] = b[key];
    }
    db.prepare(`UPDATE vendors SET extra_fields = ? WHERE id = ?`).run(JSON.stringify(extra), vendor.id);
  });

  function saveUploadedFiles(vendorId, stage, userId, files) {
    const stmt = db.prepare(`
      INSERT INTO vendor_attachments
        (vendor_id, stage, filename, mimetype, size, stored_path, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const f of files || []) {
      stmt.run(vendorId, stage, f.originalname, f.mimetype, f.size, f.path, userId || null);
    }
  }

  // Persist everything the supplier filled in on their form, then hand off to
  // doTransition so the workflow advances to PENDING_VENDOR_ADMIN. Wrapped in
  // a single transaction so a failure anywhere rolls back the whole write.
  const persistSupplierData = db.transaction((vendor, b) => {
    // 1) Identity + payment fields on the main vendor row.
    db.prepare(`
      UPDATE vendors SET
        legal_name         = COALESCE(NULLIF(?, ''), legal_name),
        payment_instrument = ?,
        tax_id             = COALESCE(NULLIF(?, ''), tax_id),
        additional_tax_id  = ?,
        currency_code      = ?,
        duns               = COALESCE(NULLIF(?, ''), duns),
        updated_at         = ?
      WHERE id = ?
    `).run(
      b.legal_name, b.payment_instrument, b.tax_id, b.additional_tax_id,
      b.currency_code, b.duns, new Date().toISOString(), vendor.id
    );

    // 2) Bank — treat supplier submission as the authoritative set.
    db.prepare(`DELETE FROM vendor_banks WHERE vendor_id = ?`).run(vendor.id);
    if (b.bank_name || b.bank_account) {
      db.prepare(`
        INSERT INTO vendor_banks
          (vendor_id, bank_name, bank_account, bank_transit, iban, swift, bank_country, approved)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(vendor.id, b.bank_name, b.bank_account, b.bank_transit, b.iban, b.swift, b.bank_country);
    }

    // 3) Address block: upsert PRIMARY / REMIT_TO / MANUFACTURING.
    const replaceAddress = (type, row) => {
      db.prepare(`DELETE FROM vendor_addresses WHERE vendor_id=? AND address_type=?`).run(vendor.id, type);
      if (!row) return;
      db.prepare(`
        INSERT INTO vendor_addresses
          (vendor_id, address_type, line1, line2, line3, line4, city, state, zip, county, country, email, po_email)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vendor.id, type,
        row.line1 || null, row.line2 || null, row.line3 || null, row.line4 || null,
        row.city || null, row.state || null, row.zip || null,
        row.county || null, row.country || null, row.email || null, row.po_email || null);
    };

    replaceAddress('PRIMARY', {
      line1: b.addr_line1, line2: b.addr_line2, line3: b.addr_line3, line4: b.addr_line4,
      city: b.addr_city, state: b.addr_state, zip: b.addr_zip,
      county: b.county_code, country: b.addr_country,
    });
    if (b.remit_to_country || b.remit_to_city || b.remit_to_address || b.remit_to_zip) {
      replaceAddress('REMIT_TO', {
        line1: b.remit_to_address, city: b.remit_to_city, state: b.remit_to_state,
        zip: b.remit_to_zip, country: b.remit_to_country,
        email: b.remit_to_supplier_email, po_email: b.remit_to_po_email,
      });
    }
    if (b.mfg_country || b.mfg_city || b.mfg_address || b.mfg_zip) {
      replaceAddress('MANUFACTURING', {
        line1: b.mfg_address, city: b.mfg_city, state: b.mfg_state,
        zip: b.mfg_zip, country: b.mfg_country,
      });
    }

    // 4) Privacy ack → merge into extra_fields JSON.
    let extra = {};
    try { extra = JSON.parse(vendor.extra_fields || '{}'); } catch { extra = {}; }
    extra.supplier = {
      privacy_ack: b.privacy_ack === '1' || b.privacy_ack === 'on' || b.privacy_ack === true,
      privacy_ack_at: new Date().toISOString(),
    };
    db.prepare(`UPDATE vendors SET extra_fields = ? WHERE id = ?`).run(
      JSON.stringify(extra), vendor.id
    );
  });

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
    (req, res) => {
      try {
        persistSupplierData(res.locals.vendor, req.body || {});
      } catch (e) {
        return res.status(500).render('error', {
          error: { message: 'Could not save supplier form: ' + (e.message || e) },
        });
      }
      return doTransition('supplier_submit', req, res);
    }
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
    (req, res) => {
      try {
        persistVendorAdminData(res.locals.vendor, req.body || {});
      } catch (e) {
        return res.status(500).render('error', {
          error: { message: 'Could not save Vendor Admin form: ' + (e.message || e) },
        });
      }
      return doTransition('vendor_admin_submit', req, res);
    }
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
    uploadLegal.any(),
    (req, res) => {
      const decision = String(req.body.decision || '').toLowerCase();
      const action = decision === 'approve' ? 'legal_approve'
                   : decision === 'reject'  ? 'legal_reject'
                   : null;
      if (!action) return res.status(400).json({ error: 'BAD_DECISION', got: decision });
      try {
        saveUploadedFiles(
          res.locals.vendor.id,
          'PENDING_LEGAL',
          req.user && req.user.id,
          req.files
        );
      } catch (e) {
        return res.status(500).render('error', {
          error: { message: 'Could not save attachments: ' + (e.message || e) },
        });
      }
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
