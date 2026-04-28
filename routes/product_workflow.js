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
//   5. /products/workflow/:id/production    — R&D production (parallel with 6)
//   6. /products/workflow/:id/competitor    — Marketing competitor analysis
//   7. /products/workflow/:id/confirmation  — terminal view
//
// Plus:
//   - /products/workflow/queue       — role-aware queue
//   - POST /products/workflow/api/fx — live FX conversion via Claude+web_search
// -----------------------------------------------------------------------------

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const multer  = require('multer');

const productWorkflow = require('../lib/product_workflow');
const productSlas     = require('../lib/product_slas');
const fxLookup        = require('../lib/fx_lookup');
const {
  requireRole,
  requireState,
  loadProductRequest,
  getUserRoles,
} = require('../middleware/require_product_role');

const dataDir   = path.join(__dirname, '..', 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads_store');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const uploadCert = multer({ dest: uploadDir, limits: { fileSize: 15 * 1024 * 1024 } });

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf-8'));
}

// Reference data — loaded once at boot (these files don't change at runtime).
const BRAND_HIERARCHY        = loadJson('product_brand_hierarchy.json');
const PRODUCT_MARKETS        = loadJson('product_markets.json');
const SAP_MATERIAL_TYPES     = loadJson('sap_material_types.json');
const UOM                    = loadJson('uom.json');
const REFERENCE_PRODUCTS     = loadJson('reference_products.json');
const PACKAGING_SITES        = loadJson('packaging_sites.json');
const FORMULA_OPTIONS        = loadJson('formula_options.json');
const LEGAL_CERTIFICATES     = loadJson('legal_certificates.json');
const DISTRIBUTION_CHANNELS  = loadJson('distribution_channels.json');
const TARGET_AGE_GROUPS      = loadJson('target_age_groups.json');
const POSITIONING_TIERS      = loadJson('positioning_tiers.json');
const PACKAGING_MATERIALS    = loadJson('packaging_materials.json');
const PACKAGING_COMPONENTS   = loadJson('packaging_components.json');
const INCOTERMS              = loadJson('incoterms.json');
const LANGUAGES              = loadJson('languages.json');
const COMPONENT_MASTER       = loadJson('component_master.json');

const labelExtract = require('../lib/label_extract');

// Build a name → master-row index for fast prefill from a reference product.
const COMPONENT_MASTER_BY_NAME = COMPONENT_MASTER.reduce((m, c) => {
  m[c.material_description.toLowerCase()] = c;
  return m;
}, {});

// Bundle reference data for views.
function refData() {
  return {
    BRAND_HIERARCHY,
    PRODUCT_MARKETS,
    SAP_MATERIAL_TYPES,
    UOM,
    REFERENCE_PRODUCTS,
    PACKAGING_SITES,
    FORMULA_OPTIONS,
    LEGAL_CERTIFICATES,
    DISTRIBUTION_CHANNELS,
    TARGET_AGE_GROUPS,
    POSITIONING_TIERS,
    PACKAGING_MATERIALS,
    PACKAGING_COMPONENTS,
    INCOTERMS,
    LANGUAGES,
    COMPONENT_MASTER,
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
    production:       safeJson(req.production_json),
    packaging:        safeJson(req.packaging_json),
    design:           safeJson(req.design_json),
    competitor:       safeJson(req.competitor_json),
    bomPackaging:     safeJsonArr(req.bom_packaging_json),
    bomFormula:       safeJsonArr(req.bom_formula_json),
    legal:            safeJson(req.legal_json),
  });
}

function safeJsonArr(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
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
  // Reference-product search.
  // - GET /products/workflow/api/reference-search?q=...                  (legacy free-text — used by the BOM tabs)
  // - GET /products/workflow/api/reference-search?material_number=...&...&material_description=...
  //                                                                       (multi-field — used by Stage 1)
  //
  // Always limited to material_type='FERT' (Finished Goods) per requirement.
  // -------------------------------------------------------------------------
  router.get('/api/reference-search', (req, res) => {
    const q       = String(req.query.q       || '').toLowerCase().trim();
    const matNum  = String(req.query.material_number || '').toLowerCase().trim();
    const matDesc = String(req.query.material_description || '').toLowerCase().trim();
    const cat     = String(req.query.category || '').toLowerCase().trim();
    const brand   = String(req.query.brand    || '').toLowerCase().trim();
    const matType = String(req.query.material_type || '').toUpperCase().trim();

    const hasAnyField = !!(q || matNum || matDesc || cat || brand || matType);
    if (!hasAnyField) return res.json({ results: [], total: 0 });

    const matches = REFERENCE_PRODUCTS.filter((p) => {
      // Hard requirement — Finished Goods only.
      if ((p.material_type || '').toUpperCase() !== 'FERT') return false;

      // Free-text search (legacy single-box) takes precedence when supplied.
      if (q) {
        return p.sku.toLowerCase().includes(q) ||
               p.name.toLowerCase().includes(q) ||
               (p.brand || '').toLowerCase().includes(q) ||
               (p.family_brand || '').toLowerCase().includes(q) ||
               (p.sub_brand || '').toLowerCase().includes(q) ||
               (p.category || '').toLowerCase().includes(q) ||
               (p.category_grouper || '').toLowerCase().includes(q) ||
               (p.material_group || '').toLowerCase().includes(q);
      }

      // Multi-field search — every supplied field must match.
      if (matNum  && !p.sku.toLowerCase().includes(matNum)) return false;
      if (matDesc && !p.name.toLowerCase().includes(matDesc)) return false;
      if (cat     && !(
            (p.category || '').toLowerCase().includes(cat) ||
            (p.category_grouper || '').toLowerCase().includes(cat)
          )) return false;
      if (brand   && !(
            (p.brand || '').toLowerCase().includes(brand) ||
            (p.family_brand || '').toLowerCase().includes(brand) ||
            (p.sub_brand || '').toLowerCase().includes(brand)
          )) return false;
      if (matType && (p.material_type || '').toUpperCase() !== matType) return false;
      return true;
    });

    const results = matches.slice(0, 50).map((p) => ({
      sku:               p.sku,
      name:              p.name,
      category_grouper:  p.category_grouper,
      category:          p.category,
      family_brand:      p.family_brand,
      brand:             p.brand,
      sub_brand:         p.sub_brand,
      material_type:     p.material_type,
      material_group:    p.material_group,
      industry_sector:   p.industry_sector,
      division:          p.division,
      base_uom:          p.base_uom,
      net_weight:        p.net_weight,
      weight_unit:       p.weight_unit,
      country_of_origin: p.country_of_origin,
    }));

    res.json({ results, total: matches.length });
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
  // Stage 5 — Production (R&D team). Runs in parallel with Stage 6.
  // -------------------------------------------------------------------------
  router.get('/:id/production',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/workflow_production', {
        ref: refData(),
        productRequest: decoded,
        attachments: loadAttachments(decoded.id, 'production'),
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  // multer.any() so we can ship multiple legal-cert files (one per certificate type).
  router.post('/:id/production',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    uploadCert.any(),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS),
    (req, res) => {
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const reqId = res.locals.productRequest.id;
      const action = String(b.action || 'save_draft');
      const production = pickProduction(b);
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests SET production_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(production), now, reqId);

      // Persist any uploaded legal certificates. The form ships them with
      // fieldnames "cert_file_<code>" so we can recover which certificate
      // type a file is attached to. Comments come in as "cert_comment_<code>".
      if (Array.isArray(req.files) && req.files.length) {
        const ins = db.prepare(`
          INSERT INTO product_request_attachments
            (product_req_id, stage, category, certificate_type,
             filename, original_name, mime_type, size_bytes, comment, uploaded_by)
          VALUES (?, 'production', 'legal_certificate', ?, ?, ?, ?, ?, ?, ?)
        `);
        const tx = db.transaction(() => {
          req.files.forEach((f) => {
            const m = /^cert_file_(.+)$/.exec(f.fieldname);
            if (!m) return;
            const code = m[1];
            const comment = (b['cert_comment_' + code] || '').toString().trim();
            ins.run(reqId, code, f.filename, f.originalname, f.mimetype, f.size, comment || null, u.id || null);
          });
        });
        tx();
      }

      if (action === 'submit') {
        // Production submit never confirms on its own — it always passes the
        // baton to R&D's Packaging Materials form. The route handler for
        // /packaging is what eventually closes R&D's track.
        const cur = res.locals.productRequest.workflow_state;
        const result = productWorkflow.transition(cur, 'submit_production');
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET production_completed_at = ?, production_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'RND_TEAM', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/packaging`);
      }

      res.redirect(`/products/workflow/${reqId}/production`);
    });

  // -------------------------------------------------------------------------
  // Stage 6 — Competitor Analysis (Marketing team). Runs in parallel with 5.
  // -------------------------------------------------------------------------
  router.get('/:id/competitor',
    requireRole(productWorkflow.ROLES.MARKETING_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/workflow_competitor', {
        ref: refData(),
        productRequest: decoded,
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/competitor',
    requireRole(productWorkflow.ROLES.MARKETING_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS),
    (req, res) => {
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const reqId = res.locals.productRequest.id;
      const action = String(b.action || 'save_draft');
      const competitor = pickCompetitor(b);
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests SET competitor_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(competitor), now, reqId);

      if (action === 'submit') {
        // Competitor submit confirms only when ALL R&D forms (production,
        // packaging, design) are already complete; otherwise stay in state.
        const rndDone =
          !!res.locals.productRequest.production_completed_at &&
          !!res.locals.productRequest.packaging_completed_at &&
          !!res.locals.productRequest.design_completed_at;
        const transitionAction = rndDone ? 'submit_competitor_final' : 'submit_competitor_partial';
        const cur = res.locals.productRequest.workflow_state;
        const result = productWorkflow.transition(cur, transitionAction);
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET competitor_completed_at = ?, competitor_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'MARKETING_TEAM', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=${transitionAction}`);
      }

      res.redirect(`/products/workflow/${reqId}/competitor`);
    });

  // -------------------------------------------------------------------------
  // Stage 5b — Packaging Materials (R&D, follows Production sequentially).
  // Gated to RND_TEAM AND to production_completed_at being set.
  // -------------------------------------------------------------------------
  router.get('/:id/packaging',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const pr = res.locals.productRequest;
      if (!pr.production_completed_at) {
        return res.redirect(`/products/workflow/${pr.id}/production`);
      }
      const decoded = decode(pr);
      res.render('products/workflow_packaging', {
        ref: refData(),
        productRequest: decoded,
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/packaging',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS),
    (req, res) => {
      const pr = res.locals.productRequest;
      if (!pr.production_completed_at) {
        return res.redirect(`/products/workflow/${pr.id}/production`);
      }
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const reqId = pr.id;
      const action = String(b.action || 'save_draft');
      const packaging = pickPackaging(b);
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests SET packaging_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(packaging), now, reqId);

      if (action === 'submit') {
        // Packaging confirms only when EVERY other R&D + Marketing track is
        // already closed (design + competitor); otherwise we stay in state.
        const allOtherDone =
          !!pr.design_completed_at &&
          !!pr.competitor_completed_at;
        const transitionAction = allOtherDone ? 'submit_packaging_final' : 'submit_packaging_partial';
        const cur = pr.workflow_state;
        const result = productWorkflow.transition(cur, transitionAction);
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET packaging_completed_at = ?, packaging_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'RND_TEAM', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=${transitionAction}`);
      }

      res.redirect(`/products/workflow/${reqId}/packaging`);
    });

  // -------------------------------------------------------------------------
  // Stage 5c — Design (R&D, parallel with Packaging Materials).
  // -------------------------------------------------------------------------
  // multer.any() so the same submit can ship a design brief, translation,
  // label image, plus arbitrary numbers of logo/pictogram/symbol files.
  // Each file is stamped with stage='design' and a category derived from
  // its fieldname.
  const FIELD_CATEGORY = {
    design_brief:       'design_brief',
    design_translation: 'design_translation',
    design_label:       'design_label',
  };
  function categoryFor(fieldname) {
    if (FIELD_CATEGORY[fieldname]) return FIELD_CATEGORY[fieldname];
    if (fieldname === 'design_logo'      || fieldname === 'design_logo[]')      return 'design_logo';
    if (fieldname === 'design_pictogram' || fieldname === 'design_pictogram[]') return 'design_pictogram';
    if (fieldname === 'design_symbol'    || fieldname === 'design_symbol[]')    return 'design_symbol';
    return null;
  }

  router.get('/:id/design',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const pr = res.locals.productRequest;
      if (!pr.production_completed_at) {
        return res.redirect(`/products/workflow/${pr.id}/production`);
      }
      const decoded = decode(pr);
      res.render('products/workflow_design', {
        ref: refData(),
        productRequest: decoded,
        attachments: loadDesignAttachments(decoded.id),
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/design',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    uploadCert.any(),                                  // reuses the multer upload dir
    requireState(productWorkflow.STATES.PENDING_PRODUCTION_AND_ANALYSIS),
    (req, res) => {
      const pr = res.locals.productRequest;
      if (!pr.production_completed_at) {
        return res.redirect(`/products/workflow/${pr.id}/production`);
      }
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const reqId = pr.id;
      const action = String(b.action || 'save_draft');
      const design = pickDesign(b);
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests SET design_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(design), now, reqId);

      // Persist files. Single-slot fields (brief/translation/label) replace
      // any existing attachment for that category; the multi-slot fields
      // (logos/pictograms/symbols) are append-only — users can clear them
      // out via dedicated DELETE endpoints if needed (future work).
      if (Array.isArray(req.files) && req.files.length) {
        const ins = db.prepare(`
          INSERT INTO product_request_attachments
            (product_req_id, stage, category, certificate_type,
             filename, original_name, mime_type, size_bytes, comment, uploaded_by)
          VALUES (?, 'design', ?, NULL, ?, ?, ?, ?, NULL, ?)
        `);
        const del = db.prepare(`
          DELETE FROM product_request_attachments
            WHERE product_req_id=? AND stage='design' AND category=?
        `);
        const tx = db.transaction(() => {
          req.files.forEach((f) => {
            const cat = categoryFor(f.fieldname);
            if (!cat) return;
            // Single-slot fields overwrite existing rows for the same category.
            if (cat === 'design_brief' || cat === 'design_translation' || cat === 'design_label') {
              del.run(reqId, cat);
            }
            ins.run(reqId, cat, f.filename, f.originalname, f.mimetype, f.size, u.id || null);
          });
        });
        tx();
      }

      if (action === 'submit') {
        const allOtherDone =
          !!pr.packaging_completed_at &&
          !!pr.competitor_completed_at;
        const transitionAction = allOtherDone ? 'submit_design_final' : 'submit_design_partial';
        const cur = pr.workflow_state;
        const result = productWorkflow.transition(cur, transitionAction);
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET design_completed_at = ?, design_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'RND_TEAM', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=${transitionAction}`);
      }

      res.redirect(`/products/workflow/${reqId}/design`);
    });

  // POST a single label image and get back the seven extracted fields.
  // Used by the "Auto-fill from label" button on the Design tab. We do NOT
  // persist the image here — the actual save happens on the main /design
  // POST when the user submits.
  router.post('/:id/api/extract-label',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    uploadCert.single('label'),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: 'image required' });
        const buf = fs.readFileSync(path.join(uploadDir, req.file.filename));
        // Keep the upload — when the user submits the design form they may
        // want to attach this same image. But discard if they don't, so we
        // delete it once we've read the bytes.
        try { fs.unlinkSync(path.join(uploadDir, req.file.filename)); } catch {}
        const fields = await labelExtract.extractLabel({
          dataBase64: buf.toString('base64'),
          mediaType: req.file.mimetype || 'image/jpeg',
        });
        res.json({ ok: true, fields });
      } catch (e) {
        res.status(500).json({ error: String(e.message || e), code: e.code });
      }
    });

  // Convenience loader for design-stage attachments.
  function loadDesignAttachments(reqId) {
    return db.prepare(`
      SELECT a.*, u.name AS uploader_name
        FROM product_request_attachments a
        LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.product_req_id = ? AND a.stage = 'design'
       ORDER BY a.id ASC
    `).all(reqId);
  }

  // -------------------------------------------------------------------------
  // Stage 7 — BOM selection (R&D, after the four parallel flags fire).
  // -------------------------------------------------------------------------
  // Search the component master + every previously-submitted BOM row across
  // all CONFIRMED requests. Used by the BOM tabs' typeahead.
  router.get('/api/component-search', (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    const cat = String(req.query.cat || '').toUpperCase();          // PACKAGING | FORMULA | (empty)
    if (!q) return res.json({ results: [] });
    const masterMatches = COMPONENT_MASTER
      .filter((c) => (cat === '' || c.bom_category === cat) &&
                     (c.material_description.toLowerCase().includes(q) ||
                      c.material_number.toLowerCase().includes(q) ||
                      c.brand.toLowerCase().includes(q) ||
                      c.category_name.toLowerCase().includes(q)))
      .slice(0, 12)
      .map((c) => Object.assign({ source: 'MASTER' }, c));

    // Also scrape components used on previously-submitted BOMs of OTHER
    // requests, so newly-introduced components are reachable. Keeps the
    // "use a component from another product" promise even if the master is
    // never updated.
    const colName = cat === 'PACKAGING' ? 'bom_packaging_json'
                  : cat === 'FORMULA'   ? 'bom_formula_json'
                  : null;
    let crossMatches = [];
    if (colName) {
      const rows = db.prepare(`
        SELECT id AS req_id, product_name, ${colName} AS bom_json
          FROM product_requests
         WHERE bom_completed_at IS NOT NULL AND ${colName} IS NOT NULL
      `).all();
      const seen = new Set(masterMatches.map((m) => m.material_number));
      rows.forEach((r) => {
        let arr; try { arr = JSON.parse(r.bom_json); } catch { return; }
        if (!Array.isArray(arr)) return;
        arr.forEach((c) => {
          if (!c || !c.material_description) return;
          if (seen.has(c.material_number)) return;
          if (!c.material_description.toLowerCase().includes(q)) return;
          seen.add(c.material_number);
          crossMatches.push(Object.assign({ source: 'CROSS', from_request: r.req_id, from_product: r.product_name }, c));
        });
      });
      crossMatches = crossMatches.slice(0, 8);
    }
    res.json({ results: masterMatches.concat(crossMatches) });
  });

  router.get('/:id/bom',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_BOM, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      // First open: prefill from the reference product's BOM, split by category
      // and resolved against the master so the SAP fields land already filled.
      let pkgRows = decoded.bomPackaging;
      let frmRows = decoded.bomFormula;
      const ref = decoded.referenceProduct || {};
      const hasRefBom = Array.isArray(ref.bom) && ref.bom.length > 0;
      if (pkgRows.length === 0 && frmRows.length === 0 && hasRefBom) {
        ref.bom.forEach((line) => {
          const m = COMPONENT_MASTER_BY_NAME[String(line.component || '').toLowerCase()] || null;
          const row = {
            source:               'REFERENCE',
            material_number:      m ? m.material_number      : '',
            material_description: line.component || '',
            category_name:        m ? m.category_name        : '',
            brand:                m ? m.brand                : '',
            material_group:       m ? m.material_group       : '',
            material_type:        m ? m.material_type        : '',
            base_uom:             line.uom || (m ? m.base_uom : ''),
            division:             m ? m.division             : '',
            volume:               null,
            quantity:             line.qty != null ? line.qty : null,
            vendor: { type: 'EXISTING', vendor_code: m ? m.default_vendor_code : '', name: '', contact: '', email: '', phone: '' },
          };
          if ((m && m.bom_category === 'PACKAGING') ||
              /(can|bottle|bag|cap|label|box|wrap|wrapper|carton|jar|cup|lid|pack|tray|seal|liner|pouch|sleeve|pallet)/i.test(row.material_description)) {
            pkgRows.push(row);
          } else {
            frmRows.push(row);
          }
        });
      }

      res.render('products/workflow_bom', {
        ref: refData(),
        productRequest: decoded,
        bomPackaging:   pkgRows,
        bomFormula:     frmRows,
        history:        loadHistory(decoded.id),
        comments:       loadComments(decoded.id),
      });
    });

  router.post('/:id/bom',
    requireRole(productWorkflow.ROLES.RND_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_BOM),
    (req, res) => {
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const reqId = res.locals.productRequest.id;
      const action = String(b.action || 'save_draft');
      const pkgRows = pickBomRows(b, 'pkg');
      const frmRows = pickBomRows(b, 'frm');
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests
           SET bom_packaging_json = ?, bom_formula_json = ?, updated_at = ?
         WHERE id = ?
      `).run(JSON.stringify(pkgRows), JSON.stringify(frmRows), now, reqId);

      if (action === 'submit') {
        const cur = res.locals.productRequest.workflow_state;
        const result = productWorkflow.transition(cur, 'submit_bom');
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET bom_completed_at = ?, bom_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'RND_TEAM', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=submit_bom`);
      }

      res.redirect(`/products/workflow/${reqId}/bom`);
    });

  // -------------------------------------------------------------------------
  // Stage 8 — R&D Director + Quality Director (parallel) approvals.
  // -------------------------------------------------------------------------
  router.get('/:id/rnd-director',
    requireRole(productWorkflow.ROLES.RND_DIRECTOR),
    loadProductRequest(db),
    requireState(
      productWorkflow.STATES.PENDING_RND_AND_QUALITY_DIRECTORS,
      productWorkflow.STATES.CONFIRMED, productWorkflow.STATES.REJECTED, productWorkflow.STATES.NEEDS_INFO),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/workflow_rnd_director', {
        ref: refData(),
        productRequest: decoded,
        attachments: loadAttachments(decoded.id, 'production'),
        designAttachments: loadDesignAttachments(decoded.id),
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/rnd-director',
    requireRole(productWorkflow.ROLES.RND_DIRECTOR),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_RND_AND_QUALITY_DIRECTORS),
    (req, res) => handleDualDirector(req, res, 'rnd'));

  router.get('/:id/quality-director',
    requireRole(productWorkflow.ROLES.QUALITY_DIRECTOR),
    loadProductRequest(db),
    requireState(
      productWorkflow.STATES.PENDING_RND_AND_QUALITY_DIRECTORS,
      productWorkflow.STATES.CONFIRMED, productWorkflow.STATES.REJECTED, productWorkflow.STATES.NEEDS_INFO),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/workflow_quality_director', {
        ref: refData(),
        productRequest: decoded,
        attachments: loadAttachments(decoded.id, 'production'),
        designAttachments: loadDesignAttachments(decoded.id),
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/quality-director',
    requireRole(productWorkflow.ROLES.QUALITY_DIRECTOR),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_RND_AND_QUALITY_DIRECTORS),
    (req, res) => handleDualDirector(req, res, 'quality'));

  // Shared dispatcher for both director POSTs. Picks the right transition
  // variant (_partial / _final) for approve based on whether the OTHER
  // director has already approved.
  function handleDualDirector(req, res, side) {
    const b = req.body || {};
    const u = res.locals.currentUser || {};
    const pr = res.locals.productRequest;
    const reqId = pr.id;
    const action = String(b.action || '');

    // Block re-submission once this side has already approved.
    const myFlagCol = side === 'rnd' ? 'rnd_director_approved_at' : 'quality_director_approved_at';
    if (pr[myFlagCol]) {
      return res.redirect(`/products/workflow/${reqId}/${side}-director`);
    }

    // The action submitted by the form is one of:
    //   <prefix>_approve | <prefix>_reject | <prefix>_request_info
    // where prefix is 'rnd_dir' for R&D Director or 'quality_dir' for Quality.
    const prefix = side === 'rnd' ? 'rnd_dir' : 'quality_dir';
    if (![`${prefix}_approve`, `${prefix}_reject`, `${prefix}_request_info`].includes(action)) {
      return res.status(400).send('Invalid action');
    }

    let transitionAction;
    if (action === `${prefix}_approve`) {
      const otherFlagCol = side === 'rnd' ? 'quality_director_approved_at' : 'rnd_director_approved_at';
      const otherDone = !!pr[otherFlagCol];
      transitionAction = `${prefix}_approve_${otherDone ? 'final' : 'partial'}`;
    } else {
      transitionAction = action;       // *_reject or *_request_info — direct mapping
    }

    const cur = pr.workflow_state;
    const result = productWorkflow.transition(cur, transitionAction);

    const tx = db.transaction(() => {
      // Stamp the approval flag for the side that just acted, so the next
      // visitor knows whether the other side is still pending.
      if (action === `${prefix}_approve`) {
        const stamps = side === 'rnd'
          ? { col: 'rnd_director_approved_at',     by: 'rnd_director_approved_by',     note: 'rnd_director_note' }
          : { col: 'quality_director_approved_at', by: 'quality_director_approved_by', note: 'quality_director_note' };
        db.prepare(`
          UPDATE product_requests
             SET ${stamps.col} = ?, ${stamps.by} = ?, ${stamps.note} = ?
           WHERE id = ?
        `).run(new Date().toISOString(), u.id || null, b.note || null, reqId);
      }
      applyTransition(reqId, result, u.id, u.role || null, b.reason_code || null, b.note || null);
    });
    tx();

    res.redirect(`/products/workflow/${reqId}/confirmation?from=${transitionAction}`);
  }

  // -------------------------------------------------------------------------
  // Stage 9 — Legal task (parallel with MDM).
  // -------------------------------------------------------------------------
  router.get('/:id/legal',
    requireRole(productWorkflow.ROLES.LEGAL),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_LEGAL_AND_MDM, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/workflow_legal', {
        ref: refData(),
        productRequest: decoded,
        attachments: loadAttachments(decoded.id, 'production'),
        designAttachments: loadDesignAttachments(decoded.id),
        legalAttachments: loadLegalAttachments(decoded.id),
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/legal',
    requireRole(productWorkflow.ROLES.LEGAL),
    loadProductRequest(db),
    uploadCert.any(),
    requireState(productWorkflow.STATES.PENDING_LEGAL_AND_MDM),
    (req, res) => {
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const pr = res.locals.productRequest;
      const reqId = pr.id;
      const action = String(b.action || 'save_draft');
      const legal = pickLegal(b);
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests SET legal_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(legal), now, reqId);

      // Persist uploaded attachments. Filenames carry the row index + the
      // collection name, so we can recover which cert/registration row each
      // file belongs to.
      if (Array.isArray(req.files) && req.files.length) {
        const ins = db.prepare(`
          INSERT INTO product_request_attachments
            (product_req_id, stage, category, certificate_type,
             filename, original_name, mime_type, size_bytes, comment, uploaded_by)
          VALUES (?, 'legal', ?, ?, ?, ?, ?, ?, NULL, ?)
        `);
        const tx = db.transaction(() => {
          req.files.forEach((f) => {
            // legal_cert_file_<idx>  →  category='legal_cert',  certificate_type=<cert_code>
            // legal_reg_file_<idx>   →  category='legal_reg',   certificate_type=<country_code>
            let mCert = /^legal_cert_file_(\d+)$/.exec(f.fieldname);
            let mReg  = /^legal_reg_file_(\d+)$/.exec(f.fieldname);
            if (mCert) {
              const idx = Number(mCert[1]);
              const certCode = (legal.certifications[idx] && legal.certifications[idx].code) || '';
              ins.run(reqId, 'legal_cert', certCode || null,
                f.filename, f.originalname, f.mimetype, f.size, u.id || null);
            } else if (mReg) {
              const idx = Number(mReg[1]);
              const country = (legal.registrations[idx] && legal.registrations[idx].country) || '';
              ins.run(reqId, 'legal_reg', country || null,
                f.filename, f.originalname, f.mimetype, f.size, u.id || null);
            }
          });
        });
        tx();
      }

      if (action === 'submit') {
        const mdmDone = !!pr.mdm_completed_at;
        const transitionAction = mdmDone ? 'submit_legal_final' : 'submit_legal_partial';
        const cur = pr.workflow_state;
        const result = productWorkflow.transition(cur, transitionAction);
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET legal_completed_at = ?, legal_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'LEGAL', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=${transitionAction}`);
      }

      res.redirect(`/products/workflow/${reqId}/legal`);
    });

  function loadLegalAttachments(reqId) {
    return db.prepare(`
      SELECT a.*, u.name AS uploader_name
        FROM product_request_attachments a
        LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.product_req_id = ? AND a.stage = 'legal'
       ORDER BY a.id ASC
    `).all(reqId);
  }

  // -------------------------------------------------------------------------
  // Stage 10 — MDM task (parallel with Legal). MDM edits the BOM rows
  // that R&D filled in to align them with SAP material master standards.
  // -------------------------------------------------------------------------
  router.get('/:id/mdm',
    requireRole(productWorkflow.ROLES.MDM_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_LEGAL_AND_MDM, productWorkflow.STATES.CONFIRMED),
    (req, res) => {
      const decoded = decode(res.locals.productRequest);
      res.render('products/workflow_mdm', {
        ref: refData(),
        productRequest: decoded,
        bomPackaging: decoded.bomPackaging,
        bomFormula:   decoded.bomFormula,
        history: loadHistory(decoded.id),
        comments: loadComments(decoded.id),
      });
    });

  router.post('/:id/mdm',
    requireRole(productWorkflow.ROLES.MDM_TEAM),
    loadProductRequest(db),
    requireState(productWorkflow.STATES.PENDING_LEGAL_AND_MDM),
    (req, res) => {
      const b = req.body || {};
      const u = res.locals.currentUser || {};
      const pr = res.locals.productRequest;
      const reqId = pr.id;
      const action = String(b.action || 'save_draft');
      const pkgRows = pickBomRows(b, 'pkg');
      const frmRows = pickBomRows(b, 'frm');
      const now = new Date().toISOString();

      db.prepare(`
        UPDATE product_requests
           SET bom_packaging_json = ?, bom_formula_json = ?, updated_at = ?
         WHERE id = ?
      `).run(JSON.stringify(pkgRows), JSON.stringify(frmRows), now, reqId);

      if (action === 'submit') {
        const legalDone = !!pr.legal_completed_at;
        const transitionAction = legalDone ? 'submit_mdm_final' : 'submit_mdm_partial';
        const cur = pr.workflow_state;
        const result = productWorkflow.transition(cur, transitionAction);
        const tx = db.transaction(() => {
          db.prepare(`
            UPDATE product_requests
               SET mdm_completed_at = ?, mdm_completed_by = ?
             WHERE id = ?
          `).run(now, u.id || null, reqId);
          applyTransition(reqId, result, u.id, u.role || 'MDM_TEAM', null, b.note || null);
        });
        tx();
        return res.redirect(`/products/workflow/${reqId}/confirmation?from=${transitionAction}`);
      }

      res.redirect(`/products/workflow/${reqId}/mdm`);
    });

  // -------------------------------------------------------------------------
  // Confirmation page (any authenticated user can view)
  // -------------------------------------------------------------------------
  router.get('/:id/confirmation', loadProductRequest(db), (req, res) => {
    const decoded = decode(res.locals.productRequest);
    res.render('products/workflow_confirmation', {
      ref: refData(),
      productRequest: decoded,
      attachments: loadAttachments(decoded.id, 'production'),
      designAttachments: loadDesignAttachments(decoded.id),
      legalAttachments: loadLegalAttachments(decoded.id),
      history: loadHistory(decoded.id),
      comments: loadComments(decoded.id),
      stateLabel: productWorkflow.STATE_LABELS[decoded.workflow_state] || decoded.workflow_state,
    });
  });

  // Download an uploaded legal-certificate file.
  router.get('/:id/attachments/:attId',
    loadProductRequest(db),
    (req, res) => {
      const att = db.prepare(`SELECT * FROM product_request_attachments WHERE id=? AND product_req_id=?`)
        .get(Number(req.params.attId), res.locals.productRequest.id);
      if (!att) return res.status(404).send('Attachment not found');
      const filePath = path.join(uploadDir, att.filename);
      if (!fs.existsSync(filePath)) return res.status(404).send('File missing on disk');
      res.download(filePath, att.original_name || att.filename);
    });

  function loadAttachments(reqId, stage) {
    return db.prepare(`
      SELECT a.*, u.name AS uploader_name
        FROM product_request_attachments a
        LEFT JOIN users u ON u.id = a.uploaded_by
       WHERE a.product_req_id = ? AND a.stage = ?
       ORDER BY a.id ASC
    `).all(reqId, stage);
  }

  return router;
};

// ---------- queue router (mounted separately so it doesn't conflict with :id)
module.exports.makeQueueRouter = function makeQueueRouter(db) {
  const router = express.Router();

  // Map a workflow state → the role/team that owns the next action. Used to
  // populate the "Assignee role" column the same way /requests does.
  const STAGE_ROLE = {
    DRAFT:                              'REQUESTOR',
    PENDING_MKTG_DIRECTOR:              'MKTG_DIRECTOR',
    PENDING_SC_DIRECTOR:                'SC_DIRECTOR',
    PENDING_PRODUCTION_AND_ANALYSIS:    'RND_TEAM / MARKETING_TEAM',
    PENDING_BOM:                        'RND_TEAM',
    PENDING_RND_AND_QUALITY_DIRECTORS:  'RND_DIRECTOR / QUALITY_DIRECTOR',
    PENDING_LEGAL_AND_MDM:              'LEGAL / MDM_TEAM',
    NEEDS_INFO:                         'REQUESTOR',
    REJECTED:                           '—',
    CONFIRMED:                          '—',
  };

  // Per-state deep-link picker. Same logic the queue view used to embed,
  // hoisted server-side so the list page is a thin renderer.
  function deepLinkFor(r, viewerRoles) {
    const id = r.id;
    const has = (role) => viewerRoles.indexOf(role) >= 0 || viewerRoles.indexOf('ADMIN') >= 0;
    const path = (s) => `/products/workflow/${id}/${s}`;
    switch (r.workflow_state) {
      case 'DRAFT':
      case 'NEEDS_INFO':
        return path('details');
      case 'PENDING_MKTG_DIRECTOR':          return path('mktg-director');
      case 'PENDING_SC_DIRECTOR':            return path('sc-director');
      case 'PENDING_PRODUCTION_AND_ANALYSIS':
        if (has('RND_TEAM')) {
          if      (!r.production_completed_at) return path('production');
          else if (!r.packaging_completed_at)  return path('packaging');
          else if (!r.design_completed_at)     return path('design');
        }
        if (has('MARKETING_TEAM')) return path('competitor');
        return path('confirmation');
      case 'PENDING_BOM':                    return has('RND_TEAM')         ? path('bom')              : path('confirmation');
      case 'PENDING_RND_AND_QUALITY_DIRECTORS':
        if (has('RND_DIRECTOR'))     return path('rnd-director');
        if (has('QUALITY_DIRECTOR')) return path('quality-director');
        return path('confirmation');
      case 'PENDING_LEGAL_AND_MDM':
        if (has('LEGAL'))    return path('legal');
        if (has('MDM_TEAM')) return path('mdm');
        return path('confirmation');
      default:                               return path('confirmation');
    }
  }

  router.get('/', (req, res) => {
    const roles = getUserRoles(req);
    const userId = req.session && req.session.userId;
    const q      = String(req.query.q      || '').trim();
    const stateF = String(req.query.status || '').trim();
    const mine   = req.query.mine === '1';

    const clauses = [];
    const args    = [];
    if (q) {
      clauses.push(`(pr.product_name LIKE ? OR CAST(pr.id AS TEXT) LIKE ? OR pr.request_type LIKE ?)`);
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (stateF) {
      clauses.push(`pr.workflow_state = ?`);
      args.push(stateF);
    }
    if (mine && userId) {
      clauses.push(`pr.requestor_user_id = ?`);
      args.push(userId);
    }
    const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

    const rows = db.prepare(`
      SELECT pr.*, u.name AS requestor_full_name
        FROM product_requests pr
        LEFT JOIN users u ON u.id = pr.requestor_user_id
       ${where}
       ORDER BY pr.updated_at DESC
       LIMIT 200
    `).all(...args).map((r) => Object.assign(r, {
      state_label:    productWorkflow.STATE_LABELS[r.workflow_state] || r.workflow_state,
      assignee_role:  STAGE_ROLE[r.workflow_state] || '—',
      open_url:       deepLinkFor(r, roles),
    }));

    res.render('products/list', {
      requests:    rows,
      stateLabels: productWorkflow.STATE_LABELS,
      query:       { q, status: stateF, mine: mine ? '1' : '' },
      viewerRoles: roles,
      activeTab:   'requests',
    });
  });

  // ---- Product Dashboard ---------------------------------------------------
  // Mirrors the main /dashboard layout but every metric is scoped to the
  // product creation workflow (product_requests + product_workflow_history).
  router.get('/dashboard', (req, res) => {
    const u = res.locals.currentUser || {};
    const userId = u.id || null;
    const roles = getUserRoles(req);

    // ---- Filters ----------------------------------------------------------
    const range = ['7','30','90','all'].includes(String(req.query.range)) ? String(req.query.range) : '30';
    const typeF = String(req.query.type || '');
    const REQUEST_TYPES = ['NEW_PRODUCT','NEW_VARIATION','MODIFICATION','DISCONTINUATION'];

    const dateClause = range === 'all'
      ? ''
      : ` AND created_at > datetime('now','-${range} days')`;
    const dateClauseConfirmed = range === 'all'
      ? ''
      : ` AND workflow_updated_at > datetime('now','-${range} days')`;
    // Same as dateClause but qualified for queries that JOIN another table
    // (otherwise SQLite can't disambiguate the created_at column).
    const dateClausePR = range === 'all'
      ? ''
      : ` AND pr.created_at > datetime('now','-${range} days')`;
    const typeClause = typeF ? ` AND request_type = '${typeF.replace(/'/g, "''")}'` : '';
    const typeClausePR = typeF ? ` AND pr.request_type = '${typeF.replace(/'/g, "''")}'` : '';

    const open    = "workflow_state IN ('DRAFT','PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR','PENDING_PRODUCTION_AND_ANALYSIS','PENDING_BOM','PENDING_RND_AND_QUALITY_DIRECTORS','PENDING_LEGAL_AND_MDM','NEEDS_INFO')";
    const closed  = "workflow_state IN ('CONFIRMED','REJECTED')";
    const onlyOne = (s) => `workflow_state = '${s}'`;

    const cnt = (whereClause, ...args) =>
      db.prepare(`SELECT COUNT(*) c FROM product_requests WHERE ${whereClause}`).get(...args).c;

    // KPIs honour the type filter; the date range applies to "in-window"
    // metrics (confirmed/rejected) but the open count is always live.
    const kpi = {
      total:        cnt(`1 ${typeClause}`),
      open:         cnt(`${open} ${typeClause}`),
      confirmed:    cnt(`workflow_state='CONFIRMED' ${typeClause}`),
      rejected:     cnt(`workflow_state='REJECTED' ${typeClause}`),
      awaiting_dir: cnt(`workflow_state IN ('PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR','PENDING_RND_AND_QUALITY_DIRECTORS') ${typeClause}`),
      in_rnd:       cnt(`workflow_state IN ('PENDING_PRODUCTION_AND_ANALYSIS','PENDING_BOM') ${typeClause}`),
      in_legal_mdm: cnt(`${onlyOne('PENDING_LEGAL_AND_MDM')} ${typeClause}`),
      mine_open:    userId ? cnt(`requestor_user_id = ? AND ${open} ${typeClause}`, userId) : 0,
    };

    // Confirmations and rejections inside the active range.
    kpi.confirmed_window = db.prepare(`
      SELECT COUNT(*) c FROM product_requests
       WHERE workflow_state='CONFIRMED' ${dateClauseConfirmed} ${typeClause}
    `).get().c;
    kpi.rejected_window = db.prepare(`
      SELECT COUNT(*) c FROM product_requests
       WHERE workflow_state='REJECTED' ${dateClauseConfirmed} ${typeClause}
    `).get().c;
    kpi.submitted_window = db.prepare(`
      SELECT COUNT(*) c FROM product_requests
       WHERE 1 ${dateClause} ${typeClause}
    `).get().c;

    // Rejection rate over closed requests (CONFIRMED + REJECTED).
    const closedTotal = kpi.confirmed + kpi.rejected;
    kpi.rejection_rate = closedTotal > 0 ? Math.round((kpi.rejected / closedTotal) * 1000) / 10 : 0;

    // Average cycle time (days) for confirmed requests in the last 90 days.
    const cycleRows = db.prepare(`
      SELECT julianday(workflow_updated_at) - julianday(created_at) AS days
        FROM product_requests
       WHERE workflow_state = 'CONFIRMED'
         AND workflow_updated_at IS NOT NULL
         AND created_at > datetime('now', '-90 days')
    `).all();
    kpi.avg_cycle_days = cycleRows.length
      ? Math.round((cycleRows.reduce((s, r) => s + r.days, 0) / cycleRows.length) * 10) / 10
      : 0;

    // By-stage counts (only OPEN states are interesting on a chart).
    const byStage = db.prepare(`
      SELECT workflow_state AS state, COUNT(*) n
        FROM product_requests
       WHERE ${open} ${typeClause}
       GROUP BY workflow_state
    `).all().map((r) => ({
      state: r.state,
      label: productWorkflow.STATE_LABELS[r.state] || r.state,
      n:     r.n,
    }));

    // Bottleneck = the open state with the most requests stacked up.
    const bottleneck = byStage.reduce((m, r) => (r.n > (m ? m.n : 0) ? r : m), null);
    kpi.bottleneck_label = bottleneck ? bottleneck.label : 'None';
    kpi.bottleneck_count = bottleneck ? bottleneck.n     : 0;

    // ---- SLA compliance per stage (for the open requests) ---------------
    // For each open request we look at how long it has been in its current
    // state (workflow_updated_at if set, otherwise created_at as a fallback).
    const openWithDays = db.prepare(`
      SELECT id, workflow_state,
             julianday('now') - julianday(COALESCE(workflow_updated_at, created_at)) AS days_in_state
        FROM product_requests
       WHERE ${open} ${typeClause}
    `).all();
    const slaPerStage = {};
    Object.keys(productSlas.STAGE_SLA_DAYS).forEach((s) => {
      slaPerStage[s] = { state: s, label: productWorkflow.STATE_LABELS[s] || s, sla: productSlas.STAGE_SLA_DAYS[s], total: 0, ok: 0, risk: 0, breach: 0, sum_days: 0 };
    });
    openWithDays.forEach((r) => {
      const bucket = slaPerStage[r.workflow_state];
      if (!bucket) return;
      const days = r.days_in_state || 0;
      const status = productSlas.slaStatus(days, bucket.sla);
      bucket.total += 1;
      bucket[status] += 1;
      bucket.sum_days += days;
    });
    const slaStages = Object.values(slaPerStage).map((b) => ({
      ...b,
      avg_days: b.total ? Math.round((b.sum_days / b.total) * 100) / 100 : 0,
    }));
    kpi.breach_count = slaStages.reduce((s, b) => s + b.breach, 0);
    kpi.risk_count   = slaStages.reduce((s, b) => s + b.risk,   0);
    kpi.ok_count     = slaStages.reduce((s, b) => s + b.ok,     0);

    // Quick lookup so the process-flow strip can pull avg_days + status by state.
    const slaStageByState = slaStages.reduce((m, b) => { m[b.state] = b; return m; }, {});

    const byType = db.prepare(`
      SELECT request_type AS type, COUNT(*) n
        FROM product_requests
       WHERE 1=1 ${typeClause}
       GROUP BY request_type
    `).all();

    // Submissions per day for the last 30 days (driven by created_at).
    const velocity = db.prepare(`
      SELECT date(created_at) AS day, COUNT(*) n
        FROM product_requests
       WHERE created_at > datetime('now', '-30 days')
       GROUP BY date(created_at)
       ORDER BY day ASC
    `).all();
    // Confirmation throughput per day for the last 30 days.
    const confirmThroughput = db.prepare(`
      SELECT date(workflow_updated_at) AS day, COUNT(*) n
        FROM product_requests
       WHERE workflow_state='CONFIRMED' AND workflow_updated_at > datetime('now','-30 days')
       GROUP BY date(workflow_updated_at)
       ORDER BY day ASC
    `).all();
    function backfill(rows) {
      const m = rows.reduce((acc, r) => { acc[r.day] = r.n; return acc; }, {});
      const out = [];
      const today = new Date();
      for (let i = 29; i >= 0; i--) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        out.push({ day: key, n: m[key] || 0 });
      }
      return out;
    }
    const fullVelocity      = backfill(velocity);
    const fullConfirmations = backfill(confirmThroughput);

    // Avg dwell time per stage. Uses LAG() over each request's history with
    // product_requests.created_at as the entry timestamp for the FIRST stage.
    const dwellRows = db.prepare(`
      WITH ordered AS (
        SELECT h.id, h.product_req_id, h.from_state,
               h.created_at AS exit_at,
               COALESCE(
                 LAG(h.created_at) OVER (PARTITION BY h.product_req_id ORDER BY h.id),
                 pr.created_at
               ) AS enter_at
          FROM product_workflow_history h
          JOIN product_requests pr ON pr.id = h.product_req_id
      )
      SELECT from_state AS state,
             AVG(julianday(exit_at) - julianday(enter_at)) AS avg_days,
             COUNT(*) AS samples
        FROM ordered
       GROUP BY from_state
    `).all().map((r) => ({
      state:    r.state,
      label:    productWorkflow.STATE_LABELS[r.state] || r.state,
      avg_days: Math.round((r.avg_days || 0) * 100) / 100,
      samples:  r.samples,
    }));

    // Funnel — how many requests have ever PASSED THROUGH each state. We
    // count distinct requests per from_state across the history, plus the
    // CONFIRMED count for the final bar.
    const funnelRows = db.prepare(`
      SELECT from_state AS state, COUNT(DISTINCT product_req_id) n
        FROM product_workflow_history
       GROUP BY from_state
    `).all();
    const funnel = (function () {
      // Display these stages in the canonical workflow order.
      const order = [
        'DRAFT',
        'PENDING_MKTG_DIRECTOR',
        'PENDING_SC_DIRECTOR',
        'PENDING_PRODUCTION_AND_ANALYSIS',
        'PENDING_BOM',
        'PENDING_RND_AND_QUALITY_DIRECTORS',
        'PENDING_LEGAL_AND_MDM',
      ];
      const m = funnelRows.reduce((acc, r) => { acc[r.state] = r.n; return acc; }, {});
      return order.map((s) => ({
        state: s,
        label: productWorkflow.STATE_LABELS[s] || s,
        n:     m[s] || 0,
      })).concat([{
        state: 'CONFIRMED',
        label: productWorkflow.STATE_LABELS.CONFIRMED,
        n:     kpi.confirmed,
      }]);
    })();

    // ---- Per-user submitter table ---------------------------------------
    // How many requests each user has submitted (any state). Date-range +
    // type filters apply.
    const submitters = db.prepare(`
      SELECT pr.requestor_user_id AS user_id,
             u.name  AS user_name,
             u.role  AS user_role,
             COUNT(*) AS submitted,
             SUM(CASE WHEN pr.workflow_state='CONFIRMED' THEN 1 ELSE 0 END) AS confirmed,
             SUM(CASE WHEN pr.workflow_state IN ('DRAFT','PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR','PENDING_PRODUCTION_AND_ANALYSIS','PENDING_BOM','PENDING_RND_AND_QUALITY_DIRECTORS','PENDING_LEGAL_AND_MDM','NEEDS_INFO') THEN 1 ELSE 0 END) AS open,
             SUM(CASE WHEN pr.workflow_state='REJECTED' THEN 1 ELSE 0 END) AS rejected,
             MAX(pr.updated_at) AS last_activity
        FROM product_requests pr
        LEFT JOIN users u ON u.id = pr.requestor_user_id
       WHERE pr.requestor_user_id IS NOT NULL ${dateClausePR} ${typeClausePR}
       GROUP BY pr.requestor_user_id
       ORDER BY submitted DESC, last_activity DESC
       LIMIT 12
    `).all();

    // ---- Per-actor performance table ------------------------------------
    // For every transition with an actor, attribute the time the actor took
    // to fire the transition (from when the request entered that state).
    // Aggregate per user.
    const actors = db.prepare(`
      WITH ordered AS (
        SELECT h.id, h.product_req_id, h.actor_user_id, h.actor_role, h.from_state,
               h.created_at AS exit_at,
               COALESCE(
                 LAG(h.created_at) OVER (PARTITION BY h.product_req_id ORDER BY h.id),
                 pr.created_at
               ) AS enter_at
          FROM product_workflow_history h
          JOIN product_requests pr ON pr.id = h.product_req_id
         WHERE h.actor_user_id IS NOT NULL
           ${range === 'all' ? '' : `AND h.created_at > datetime('now','-${range} days')`}
      )
      SELECT actor_user_id AS user_id,
             u.name        AS user_name,
             u.role        AS user_role,
             COUNT(*)      AS actions,
             AVG(julianday(exit_at) - julianday(enter_at)) AS avg_days,
             MAX(o.exit_at) AS last_action_at
        FROM ordered o
        LEFT JOIN users u ON u.id = o.actor_user_id
       GROUP BY actor_user_id
       ORDER BY actions DESC
       LIMIT 12
    `).all().map((r) => {
      const sla = productSlas.ROLE_SLA_DAYS[r.user_role];
      const avg = r.avg_days != null ? Math.round(r.avg_days * 100) / 100 : 0;
      return {
        ...r,
        avg_days:    avg,
        sla_days:    sla != null ? sla : null,
        sla_status:  sla != null ? productSlas.slaStatus(avg, sla) : null,
      };
    });

    // Tasks the viewer's role can act on right now.
    let myTasks = [];
    const stateForRole = (() => {
      if (roles.includes('ADMIN')) {
        return [
          'DRAFT','PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR',
          'PENDING_PRODUCTION_AND_ANALYSIS','PENDING_BOM',
          'PENDING_RND_AND_QUALITY_DIRECTORS','PENDING_LEGAL_AND_MDM','NEEDS_INFO',
        ];
      }
      if (roles.includes('MKTG_DIRECTOR'))    return ['PENDING_MKTG_DIRECTOR'];
      if (roles.includes('SC_DIRECTOR'))      return ['PENDING_SC_DIRECTOR'];
      if (roles.includes('RND_DIRECTOR'))     return ['PENDING_RND_AND_QUALITY_DIRECTORS'];
      if (roles.includes('QUALITY_DIRECTOR')) return ['PENDING_RND_AND_QUALITY_DIRECTORS'];
      if (roles.includes('LEGAL'))            return ['PENDING_LEGAL_AND_MDM'];
      if (roles.includes('MDM_TEAM'))         return ['PENDING_LEGAL_AND_MDM'];
      if (roles.includes('RND_TEAM'))         return ['PENDING_PRODUCTION_AND_ANALYSIS', 'PENDING_BOM'];
      if (roles.includes('MARKETING_TEAM'))   return ['PENDING_PRODUCTION_AND_ANALYSIS'];
      return [];
    })();
    if (stateForRole.length) {
      const placeholders = stateForRole.map(() => '?').join(',');
      myTasks = db.prepare(`
        SELECT pr.*, u.name AS requestor_full_name
          FROM product_requests pr
          LEFT JOIN users u ON u.id = pr.requestor_user_id
         WHERE pr.workflow_state IN (${placeholders})
         ORDER BY pr.updated_at DESC
         LIMIT 12
      `).all(...stateForRole).map((r) => Object.assign(r, {
        state_label: productWorkflow.STATE_LABELS[r.workflow_state] || r.workflow_state,
        open_url:    deepLinkFor(r, roles),
      }));
    }

    // Things this user submitted, most recent first.
    const mySubmitted = userId
      ? db.prepare(`
          SELECT id, product_name, request_type, workflow_state, created_at, updated_at
            FROM product_requests
           WHERE requestor_user_id = ?
           ORDER BY id DESC LIMIT 10
        `).all(userId).map((r) => Object.assign(r, {
          state_label: productWorkflow.STATE_LABELS[r.workflow_state] || r.workflow_state,
        }))
      : [];

    // Recent activity feed across all product requests.
    const recent = db.prepare(`
      SELECT h.*, pr.product_name, u.name AS actor_name
        FROM product_workflow_history h
        JOIN product_requests pr ON pr.id = h.product_req_id
        LEFT JOIN users u ON u.id = h.actor_user_id
       ORDER BY h.id DESC
       LIMIT 12
    `).all();

    res.render('products/dashboard', {
      kpi,
      byStage,
      byType,
      velocity:        fullVelocity,
      confirmations:   fullConfirmations,
      dwell:           dwellRows,
      funnel,
      slaStages,
      slaStageByState,
      submitters,
      actors,
      myTasks,
      mySubmitted,
      recent,
      stateLabels: productWorkflow.STATE_LABELS,
      stageOrder:  ['DRAFT','PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR','PENDING_PRODUCTION_AND_ANALYSIS','PENDING_BOM','PENDING_RND_AND_QUALITY_DIRECTORS','PENDING_LEGAL_AND_MDM'],
      stageSlas:   productSlas.STAGE_SLA_DAYS,
      totalSlaDays: productSlas.TOTAL_CYCLE_SLA_DAYS,
      filters:     { range, type: typeF, requestTypes: REQUEST_TYPES },
      activeTab:   'dashboard',
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

// ---------- Stage 5 — Production (R&D) -------------------------------------

function pickProduction(b) {
  // Lead time auto-derived server-side from the two dates so it can't drift
  // away from the form values even if the user edits HTML.
  const startStr  = b.prd_launch_start_date || '';
  const targetStr = b.prd_launch_target_date || '';
  let leadWeeks = null;
  if (startStr && targetStr) {
    const start = new Date(startStr + 'T00:00:00Z');
    const targ  = new Date(targetStr + 'T00:00:00Z');
    if (!isNaN(start) && !isNaN(targ) && targ > start) {
      leadWeeks = Math.round((targ - start) / (7 * 24 * 3600 * 1000));
    }
  }
  return {
    plan: {
      launch_start_date:  startStr,
      launch_target_date: targetStr,
      lead_time_weeks:    leadWeeks,
    },
    packaging: {
      origin:      b.pkg_origin      || '',   // NATIONAL | IMPORTED
      region:      b.pkg_region      || '',
      country:     b.pkg_country     || '',
      site:        b.pkg_site        || '',
      launch_type: b.pkg_launch_type || '',   // LONG_TERM | LIMITED_TIME
    },
    formula: {
      origin:        b.frm_origin        || '',  // NATIONAL | IMPORTED
      category:      b.frm_category      || '',
      class:         b.frm_class         || '',
      brand_tier:    b.frm_brand_tier    || '',
      formula_type:  b.frm_formula_type  || '',
      flavor:        b.frm_flavor        || '',
      color:         b.frm_color         || '',
      appearance:    b.frm_appearance    || '',
      cold_storage:  b.frm_cold_storage  || '',  // YES | NO
      carbonated:    b.frm_carbonated    || '',  // YES | NO
      certificates:  pickCertificateMeta(b),
    },
  };
}

// Capture certificate dropdown selections + comments without the file (files
// are persisted in the attachments table). Returns an array so multiple
// certificates can be associated with one request.
function pickCertificateMeta(b) {
  const codes = [].concat(b.cert_selected || []);
  return codes
    .map((code) => ({
      code,
      comment: (b['cert_comment_' + code] || '').toString().trim(),
    }))
    .filter((c) => !!c.code);
}

// ---------- Stage 5b — Packaging Materials (R&D) ---------------------------

function pickPackaging(b) {
  // Components ship as:
  //   pkm_component_selected[] = ['CAP','LABEL', ...]           (multi-select)
  //   pkm_component_status_<CODE>  = 'NEW' | 'EXISTING' | 'MODIFICATION'
  //   pkm_component_description_<CODE> = textarea
  const codes = [].concat(b.pkm_component_selected || []);
  const components = codes.map((code) => ({
    code,
    status:      b['pkm_component_status_'      + code] || '',
    description: b['pkm_component_description_' + code] || '',
  })).filter((c) => !!c.code);

  // Incoterms: each selected term carries a description.
  const incotermCodes = [].concat(b.pkm_incoterm_selected || []);
  const incoterms = incotermCodes.map((code) => ({
    code,
    description: b['pkm_incoterm_description_' + code] || '',
  })).filter((c) => !!c.code);

  // Updated forecast volumes (mirrors pickForecast).
  const volumeUpdated = {};
  ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].forEach((m) => {
    volumeUpdated[`y1_${m}`] = num(b[`pkm_vol_y1_${m}`]);
  });
  for (let y = 2; y <= 5; y++) volumeUpdated[`y${y}`] = num(b[`pkm_vol_y${y}`]);
  const y1Total = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
    .reduce((s, m) => s + (volumeUpdated[`y1_${m}`] || 0), 0);
  volumeUpdated.total_y1 = y1Total;
  volumeUpdated.total_y5 = y1Total
    + (volumeUpdated.y2 || 0) + (volumeUpdated.y3 || 0)
    + (volumeUpdated.y4 || 0) + (volumeUpdated.y5 || 0);

  // Comparison rows: similar products in other markets.
  const cmpSku    = [].concat(b.pkm_cmp_sku    || []);
  const cmpName   = [].concat(b.pkm_cmp_name   || []);
  const cmpMarket = [].concat(b.pkm_cmp_market || []);
  const cmpCcy    = [].concat(b.pkm_cmp_shelf_local_ccy || []);
  const cmpLocal  = [].concat(b.pkm_cmp_shelf_local || []);
  const cmpUsd    = [].concat(b.pkm_cmp_shelf_usd   || []);
  const comparisons = [];
  for (let i = 0; i < Math.max(cmpSku.length, cmpName.length, cmpMarket.length); i++) {
    if (!cmpSku[i] && !cmpName[i] && !cmpMarket[i]) continue;
    comparisons.push({
      sku:              cmpSku[i]    || '',
      name:             cmpName[i]   || '',
      market:           cmpMarket[i] || '',
      shelf_local:      num(cmpLocal[i]),
      shelf_local_ccy:  cmpCcy[i]    || '',
      shelf_usd:        num(cmpUsd[i]),
    });
  }

  return {
    materials: {
      status:         b.pkm_status        || '',   // EXISTING | NEW | MODIFICATION
      material_type:  b.pkm_material_type || '',
      height:         num(b.pkm_height),
      width:          num(b.pkm_width),
      volume:         num(b.pkm_volume),
      dim_unit:       b.pkm_dim_unit      || '',
      volume_unit:    b.pkm_volume_unit   || '',
      description:    b.pkm_description   || '',
      units_per_case: num(b.pkm_units_per_case),
      case_pack_label:b.pkm_case_pack_label || '',  // free text e.g. "12-pack"
    },
    components,
    incoterms,
    cost_updated: {
      cost_local:        num(b.pkm_cost_local),
      cost_local_ccy:    b.pkm_cost_local_ccy   || '',
      cost_usd:          num(b.pkm_cost_usd),
      shelf_local:       num(b.pkm_shelf_local),
      shelf_local_ccy:   b.pkm_shelf_local_ccy  || '',
      shelf_usd:         num(b.pkm_shelf_usd),
    },
    volume_updated: volumeUpdated,
    rationale_price:    b.pkm_rationale_price  || '',
    rationale_volume:   b.pkm_rationale_volume || '',
    inventory_agreement: b.pkm_inventory_agreement || '',
    comparisons,
  };
}

// ---------- Stage 9 — Legal task (certs + country registrations) -----------

function pickLegal(b) {
  // Certifications: arrays of code, status, comment indexed by row.
  const cCodes    = [].concat(b.legal_cert_code     || []);
  const cStatuses = [].concat(b.legal_cert_status   || []);
  const cComments = [].concat(b.legal_cert_comment  || []);
  const certifications = [];
  for (let i = 0; i < cCodes.length; i++) {
    const code = (cCodes[i] || '').trim();
    if (!code) continue;
    certifications.push({
      code,
      status:  (cStatuses[i] || '').toUpperCase(),  // OBTAINED|IN_PROGRESS|EXPIRED|NOT_OBTAINED|NOT_APPLICABLE
      comment: cComments[i] || '',
    });
  }

  // Packaging country registrations.
  const rCountries = [].concat(b.legal_reg_country || []);
  const rStatuses  = [].concat(b.legal_reg_status  || []);
  const rNumbers   = [].concat(b.legal_reg_number  || []);
  const rComments  = [].concat(b.legal_reg_comment || []);
  const registrations = [];
  for (let i = 0; i < rCountries.length; i++) {
    const country = (rCountries[i] || '').trim();
    if (!country) continue;
    registrations.push({
      country,
      status:              (rStatuses[i] || '').toUpperCase(),  // REGISTERED|IN_PROGRESS|NOT_REGISTERED|NOT_REQUIRED
      registration_number: rNumbers[i]  || '',
      comment:             rComments[i] || '',
    });
  }

  return { certifications, registrations };
}

// ---------- Stage 7 — BOM rows (Packaging + Formula) -----------------------

// Each tab posts arrays of fields with the same indexing convention used by
// other repeating-row forms. The prefix is 'pkg' for the packaging tab and
// 'frm' for the formula tab. Empty rows (no description AND no material #)
// are dropped server-side.
function pickBomRows(b, prefix) {
  const arr = (k) => [].concat(b[`${prefix}_${k}`] || []);
  const sources = arr('source');
  const matNums = arr('material_number');
  const descs   = arr('material_description');
  const cats    = arr('category_name');
  const brands  = arr('brand');
  const groups  = arr('material_group');
  const types   = arr('material_type');
  const uoms    = arr('base_uom');
  const divs    = arr('division');
  const vols    = arr('volume');
  const qtys    = arr('quantity');
  const vTypes  = arr('vendor_type');
  const vCodes  = arr('vendor_code');
  const vNames  = arr('vendor_name');
  const vContacts = arr('vendor_contact');
  const vEmails = arr('vendor_email');
  const vPhones = arr('vendor_phone');

  const len = Math.max(matNums.length, descs.length);
  const out = [];
  for (let i = 0; i < len; i++) {
    const desc = (descs[i] || '').trim();
    const mat  = (matNums[i] || '').trim();
    if (!desc && !mat) continue;
    out.push({
      source:               (sources[i] || 'NEW').toUpperCase(),
      material_number:      mat,
      material_description: desc,
      category_name:        cats[i]   || '',
      brand:                brands[i] || '',
      material_group:       groups[i] || '',
      material_type:        types[i]  || '',
      base_uom:             uoms[i]   || '',
      division:             divs[i]   || '',
      volume:               num(vols[i]),
      quantity:             num(qtys[i]),
      vendor: {
        type:        (vTypes[i]  || 'EXISTING').toUpperCase(),
        vendor_code: vCodes[i]   || '',
        name:        vNames[i]   || '',
        contact:     vContacts[i]|| '',
        email:       vEmails[i]  || '',
        phone:       vPhones[i]  || '',
      },
    });
  }
  return out;
}

// ---------- Stage 5c — Design (R&D) ----------------------------------------

function pickDesign(b) {
  return {
    brief: {
      languages: [].concat(b.dsn_languages || []),
      // Free-text notes alongside the brief upload.
      notes:     b.dsn_brief_notes || '',
    },
    agency: {
      name:        b.dsn_agency_name        || '',
      vendor_code: b.dsn_agency_vendor_code || '',
      contact:     b.dsn_agency_contact     || '',
      email:       b.dsn_agency_email       || '',
      phone:       b.dsn_agency_phone       || '',
    },
    label: {
      marketing_text:        b.dsn_marketing_text        || '',
      claims:                b.dsn_claims                || '',
      legal_claims:          b.dsn_legal_claims          || '',
      environmental_claims:  b.dsn_environmental_claims  || '',
      nutritional_claims:    b.dsn_nutritional_claims    || '',
      dietary_claims:        b.dsn_dietary_claims        || '',
      contacts:              b.dsn_contacts              || '',
    },
  };
}

// ---------- Stage 6 — Competitor Analysis (Marketing) ----------------------

function pickCompetitor(b) {
  const competitors = [];
  // Competitor rows ship as competitor_name[], competitor_product[],
  // competitor_price_local[], competitor_price_usd[]. Index by position.
  const names    = [].concat(b.competitor_name    || []);
  const products = [].concat(b.competitor_product || []);
  const local    = [].concat(b.competitor_price_local || []);
  const usd      = [].concat(b.competitor_price_usd   || []);
  const ccyArr   = [].concat(b.competitor_price_local_ccy || []);
  for (let i = 0; i < Math.max(names.length, products.length); i++) {
    if (!names[i] && !products[i]) continue;
    competitors.push({
      name:        names[i]    || '',
      product:     products[i] || '',
      price_local: num(local[i]),
      price_local_ccy: ccyArr[i] || '',
      price_usd:   num(usd[i]),
    });
  }
  return {
    market_type:     b.cmp_market_type   || '',   // EXISTING | NEW
    countries:       [].concat(b.cmp_countries || []),
    channels:        [].concat(b.cmp_channels  || []),
    target_ages:     [].concat(b.cmp_target_ages || []),
    positioning:     b.cmp_positioning  || '',
    market_trends:   b.cmp_market_trends || '',
    competitors,
  };
}
