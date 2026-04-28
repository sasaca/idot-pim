// routes/product_workflow.js
// -----------------------------------------------------------------------------
// Product creation workflow router.
//
// Stages:
//   1. /products/workflow/new        — initiate (any authenticated user)
//   2. /products/workflow/:id/details — multi-tab Marketing/Brand/R&D/Forecast
//      detail form (requestor)
//   3. /products/workflow/:id/mktg-director — Marketing Director approval
//   4. /products/workflow/:id/sc-director   — Supply Chain Director approval
//   5. /products/workflow/:id/confirmation  — terminal view
//
// Plus:
//   - /products/workflow/queue       — role-aware queue
//   - POST /products/workflow/api/fx — live FX conversion via Claude+web_search
// -----------------------------------------------------------------------------

const express = require('express');
const fs      = require('fs');
const path    = require('path');

const productWorkflow = require('../lib/product_workflow');
const fxLookup        = require('../lib/fx_lookup');
const {
  requireRole,
  requireState,
  loadProductRequest,
  getUserRoles,
} = require('../middleware/require_product_role');

const dataDir = path.join(__dirname, '..', 'data');
function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf-8'));
}

// Reference data — loaded once at boot (these files don't change at runtime).
const BRAND_HIERARCHY     = loadJson('product_brand_hierarchy.json');
const PRODUCT_MARKETS     = loadJson('product_markets.json');
const SAP_MATERIAL_TYPES  = loadJson('sap_material_types.json');
const UOM                 = loadJson('uom.json');
const REFERENCE_PRODUCTS  = loadJson('reference_products.json');

// Bundle reference data for views.
function refData() {
  return {
    BRAND_HIERARCHY,
    PRODUCT_MARKETS,
    SAP_MATERIAL_TYPES,
    UOM,
    REFERENCE_PRODUCTS,
    REJECT_REASONS: productWorkflow.REJECT_REASONS,
    INFO_REASONS:   productWorkflow.INFO_REASONS,
    STATE_LABELS:   productWorkflow.STATE_LABELS,
  };
}

// Parse JSON columns into objects, leaving null/empty as {}.
function decode(req) {
  if (!req) return null;
  return Object.assign({}, req, {
    marketing:        safeJson(req.marketing_json),
    brand:            safeJson(req.brand_json),
    rnd:              safeJson(req.rnd_json),
    forecast:         safeJson(req.forecast_json),
    referenceProduct: safeJson(req.reference_product_json),
  });
}

function safeJson(s) {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return {}; }
}

module.exports = function makeRouter(db) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true, limit: '4mb' }));
  router.use(express.json({ limit: '2mb' }));

  // --- helpers ---------------------------------------------------------------

  // Apply a state transition + insert history (and a comment if note given).
  const applyTransition = db.transaction((reqId, result, userId, userRole, reasonCode, note) => {
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE product_requests
         SET workflow_state = ?, workflow_updated_at = ?, workflow_updated_by = ?, updated_at = ?
       WHERE id = ?
    `).run(result.nextState, now, userId || null, now, reqId);

    db.prepare(`
      INSERT INTO product_workflow_history
        (product_req_id, action, from_state, to_state, actor_user_id, actor_role, reason_code, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reqId, result.action, result.fromState, result.nextState,
      userId || null, userRole || null, reasonCode || null, note || null
    );

    if (note && note.trim()) {
      db.prepare(`
        INSERT INTO product_workflow_comments
          (product_req_id, author_user_id, author_role, stage, body)
        VALUES (?, ?, ?, ?, ?)
      `).run(reqId, userId || null, userRole || null, result.fromState, note.trim());
    }
  });

  function loadHistory(reqId) {
    return db.prepare(`
      SELECT h.*, u.name AS actor_name
        FROM product_workflow_history h
        LEFT JOIN users u ON u.id = h.actor_user_id
       WHERE h.product_req_id = ?
       ORDER BY h.id ASC
    `).all(reqId);
  }
  function loadComments(reqId) {
    return db.prepare(`
      SELECT c.*, u.name AS author_name
        FROM product_workflow_comments c
        LEFT JOIN users u ON u.id = c.author_user_id
       WHERE c.product_req_id = ?
       ORDER BY c.id ASC
    `).all(reqId);
  }

  // -------------------------------------------------------------------------
  // Stage 1 — Initiate
  // -------------------------------------------------------------------------
  router.get('/new', (req, res) => {
    res.render('products/new_initiate', {
      ref: refData(),
      productRequest: null,
      currentUser: res.locals.currentUser,
    });
  });

  router.post('/new', (req, res) => {
    const b = req.body || {};
    const u = res.locals.currentUser || {};
    const today = new Date().toISOString().slice(0, 10);

    let referenceJson = null;
    if (b.reference_sku) {
      const rp = REFERENCE_PRODUCTS.find((p) => p.sku === b.reference_sku);
      if (rp) referenceJson = JSON.stringify(rp);
    }

    const result = db.prepare(`
      INSERT INTO product_requests
        (request_type, product_name, requestor_user_id, requestor_name, requestor_email,
         request_date, reference_sku, reference_product_json, workflow_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT')
    `).run(
      b.request_type || null,
      b.product_name || null,
      u.id || null,
      u.name || null,
      u.email || null,
      b.request_date || today,
      b.reference_sku || null,
      referenceJson,
    );

    res.redirect(`/products/workflow/${result.lastInsertRowid}/details`);
  });

  // -------------------------------------------------------------------------
  // Reference-product search (used by Stage 1's typeahead).
  // GET /products/workflow/api/reference-search?q=cola
  // -------------------------------------------------------------------------
  router.get('/api/reference-search', (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ results: [] });
    const results = REFERENCE_PRODUCTS
      .filter((p) =>
        p.sku.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        (p.brand || '').toLowerCase().includes(q) ||
        (p.category || '').toLowerCase().includes(q))
      .slice(0, 12)
      .map((p) => ({
        sku: p.sku, name: p.name, category: p.category, brand: p.brand,
        sub_brand: p.sub_brand, material_type: p.material_type,
      }));
    res.json({ results });
  });

  // -------------------------------------------------------------------------
  // FX conversion endpoint — POST { from, to } → { rate, asOf, source, converted }
  // -------------------------------------------------------------------------
  router.post('/api/fx', async (req, res) => {
    const from = String((req.body && req.body.from) || '').toUpperCase();
    const to   = String((req.body && req.body.to)   || '').toUpperCase();
    const amount = Number((req.body && req.body.amount) || 0);
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });
    try {
      const fx = await fxLookup.getFxRate(from, to);
      const converted = Number.isFinite(amount) && amount > 0 ? amount * fx.rate : null;
      res.json({ ok: true, from, to, rate: fx.rate, asOf: fx.asOf, source: fx.source, amount, converted });
    } catch (e) {
      res.status(500).json({ error: String(e.message || e), code: e.code });
    }
  });

  // -------------------------------------------------------------------------
  // Stage 2 — Details (multi-tab)
  // -------------------------------------------------------------------------
  router.get('/:id/details',
    loadProductRequest(db),
    requireState(productWorkflow.STATES.DRAFT, productWorkflow.STATES.NEEDS_INFO),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/new_details', {
        ref: refData(),
        productRequest: decoded,
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/details',
    loadProductRequest(db),
    requireState(productWorkflow.STATES.DRAFT, productWorkflow.STATES.NEEDS_INFO),
    (req, res) => {
      const b = req.body || {};
      const action = String(b.action || 'save_draft');
      const reqId = res.locals.productRequest.id;

      // Pull each tab's fields out of the body and store as JSON.
      const marketing = pickMarketing(b);
      const brand     = pickBrand(b);
      const rnd       = pickRnd(b);
      const forecast  = pickForecast(b);

      db.prepare(`
        UPDATE product_requests
           SET marketing_json = ?, brand_json = ?, rnd_json = ?, forecast_json = ?, updated_at = ?
         WHERE id = ?
      `).run(
        JSON.stringify(marketing),
        JSON.stringify(brand),
        JSON.stringify(rnd),
        JSON.stringify(forecast),
        new Date().toISOString(),
        reqId,
      );

      if (action === 'submit') {
        const u = res.locals.currentUser || {};
        const cur = res.locals.productRequest.workflow_state;
        const result = productWorkflow.transition(cur, 'submit_details');
        applyTransition(reqId, result, u.id, u.role || 'REQUESTOR', null, b.note || null);
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=submit_details`);
      }

      res.redirect(`/products/workflow/${reqId}/details`);
    });

  // -------------------------------------------------------------------------
  // Stage 3 — Marketing Director approval
  // -------------------------------------------------------------------------
  router.get('/:id/mktg-director',
    requireRole(productWorkflow.ROLES.MKTG_DIRECTOR),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_MKTG_DIRECTOR),
    (req, res) => renderApproval(res, 'mktg_director'));

  router.post('/:id/mktg-director',
    requireRole(productWorkflow.ROLES.MKTG_DIRECTOR),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_MKTG_DIRECTOR),
    (req, res) => handleApproval(req, res, 'mktg'));

  // -------------------------------------------------------------------------
  // Stage 4 — Supply Chain Director approval
  // -------------------------------------------------------------------------
  router.get('/:id/sc-director',
    requireRole(productWorkflow.ROLES.SC_DIRECTOR),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_SC_DIRECTOR),
    (req, res) => renderApproval(res, 'sc_director'));

  router.post('/:id/sc-director',
    requireRole(productWorkflow.ROLES.SC_DIRECTOR),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_SC_DIRECTOR),
    (req, res) => handleApproval(req, res, 'sc'));

  function renderApproval(res, stage) {
    const decoded = decode(res.locals.productRequest);
    res.render('products/' + (stage === 'sc_director' ? 'workflow_sc_director' : 'workflow_mktg_director'), {
      ref: refData(),
      productRequest: decoded,
      history: loadHistory(decoded.id),
      comments: loadComments(decoded.id),
    });
  }

  function handleApproval(req, res, prefix) {
    const b = req.body || {};
    const u = res.locals.currentUser || {};
    const reqId = res.locals.productRequest.id;
    const cur = res.locals.productRequest.workflow_state;
    const action = String(b.action || '');
    const allowed = [`${prefix}_approve`, `${prefix}_reject`, `${prefix}_request_info`];
    if (!allowed.includes(action)) return res.status(400).send('Invalid action');

    const result = productWorkflow.transition(cur, action);
    applyTransition(
      reqId, result, u.id, u.role || null,
      b.reason_code || null, b.note || null
    );
    res.redirect(`/products/workflow/${reqId}/confirmation?from=${action}`);
  }

  // -------------------------------------------------------------------------
  // Confirmation page (any authenticated user can view)
  // -------------------------------------------------------------------------
  router.get('/:id/confirmation', loadProductRequest(db), (req, res) => {
    const decoded = decode(res.locals.productRequest);
    res.render('products/workflow_confirmation', {
      ref: refData(),
      productRequest: decoded,
      history: loadHistory(decoded.id),
      comments: loadComments(decoded.id),
      stateLabel: productWorkflow.STATE_LABELS[decoded.workflow_state] || decoded.workflow_state,
    });
  });

  return router;
};

// ---------- queue router (mounted separately so it doesn't conflict with :id)
module.exports.makeQueueRouter = function makeQueueRouter(db) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const roles = getUserRoles(req);
    const isAdmin = roles.includes('ADMIN');

    // Each role sees the queue relevant to them. Admin sees all.
    let states = [];
    if (isAdmin) {
      states = ['DRAFT','PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR','NEEDS_INFO','REJECTED','CONFIRMED'];
    } else if (roles.includes('MKTG_DIRECTOR')) {
      states = ['PENDING_MKTG_DIRECTOR'];
    } else if (roles.includes('SC_DIRECTOR')) {
      states = ['PENDING_SC_DIRECTOR'];
    } else {
      states = ['DRAFT', 'NEEDS_INFO'];
    }
    const placeholders = states.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT pr.*, u.name AS requestor_full_name
        FROM product_requests pr
        LEFT JOIN users u ON u.id = pr.requestor_user_id
       WHERE pr.workflow_state IN (${placeholders})
       ORDER BY pr.updated_at DESC
       LIMIT 200
    `).all(...states);

    res.render('products/workflow_queue', {
      requests: rows,
      states,
      stateLabels: productWorkflow.STATE_LABELS,
    });
  });

  return router;
};

// ---------- per-tab body extractors (one place to edit when tabs evolve) ----

function pickMarketing(b) {
  return {
    market:           b.mkt_market           || '',
    rationale:        b.mkt_rationale        || '',
    positioning:      b.mkt_positioning      || '',
    launch_plan:      b.mkt_launch_plan      || '',
    packaging_status: b.mkt_packaging_status || '',  // NEW | MODIFICATION
    formula_status:   b.mkt_formula_status   || '',  // NEW | MODIFICATION
  };
}

function pickBrand(b) {
  return {
    category_grouper: b.brand_category_grouper || '',
    category:         b.brand_category         || '',
    family_brand:     b.brand_family_brand     || '',
    brand:            b.brand_brand            || '',
    sub_brand:        b.brand_sub_brand        || '',
  };
}

function pickRnd(b) {
  return {
    material_type:        b.rnd_material_type        || '',
    base_uom:             b.rnd_base_uom             || '',
    length:               num(b.rnd_length),
    width:                num(b.rnd_width),
    height:               num(b.rnd_height),
    dim_unit:             b.rnd_dim_unit             || '',
    net_weight:           num(b.rnd_net_weight),
    gross_weight:         num(b.rnd_gross_weight),
    weight_unit:          b.rnd_weight_unit          || '',
    volume:               num(b.rnd_volume),
    volume_unit:          b.rnd_volume_unit          || '',
    mfg_price:            num(b.rnd_mfg_price),
    mfg_price_ccy:        b.rnd_mfg_price_ccy        || 'USD',
    retail_price_usd:     num(b.rnd_retail_price_usd),
    retail_price_local:   num(b.rnd_retail_price_local),
    retail_price_local_ccy: b.rnd_retail_price_local_ccy || '',
    fx_rate:              num(b.rnd_fx_rate),
    fx_as_of:             b.rnd_fx_as_of             || '',
    fx_source:            b.rnd_fx_source            || '',
    contract_status:      b.rnd_contract_status      || '',  // EXISTING_VALID | NEW_NEEDED
    contract_supplier:    b.rnd_contract_supplier    || '',
  };
}

function pickForecast(b) {
  const out = {};
  ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].forEach((m) => {
    out[`y1_${m}`] = num(b[`fc_y1_${m}`]);
  });
  for (let y = 2; y <= 5; y++) out[`y${y}`] = num(b[`fc_y${y}`]);
  // Recompute totals server-side regardless of what the client sent.
  const y1Total = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    .reduce((s, m) => s + (out[`y1_${m}`] || 0), 0);
  out.total_y1 = y1Total;
  out.total_y5 = y1Total + (out.y2 || 0) + (out.y3 || 0) + (out.y4 || 0) + (out.y5 || 0);
  return out;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
