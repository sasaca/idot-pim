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

const labelExtract = require('../lib/label_extract');

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
  // Confirmation page (any authenticated user can view)
  // -------------------------------------------------------------------------
  router.get('/:id/confirmation', loadProductRequest(db), (req, res) => {
    const decoded = decode(res.locals.productRequest);
    res.render('products/workflow_confirmation', {
      ref: refData(),
      productRequest: decoded,
      attachments: loadAttachments(decoded.id, 'production'),
      designAttachments: loadDesignAttachments(decoded.id),
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

  router.get('/', (req, res) => {
    const roles = getUserRoles(req);
    const isAdmin = roles.includes('ADMIN');

    // Each role sees the queue relevant to them. Admin sees all.
    // For RND_TEAM / MARKETING_TEAM we add an extra filter so the team only
    // sees rows where THEIR side is still incomplete.
    let states = [];
    let extraWhere = '';
    if (isAdmin) {
      states = [
        'DRAFT','PENDING_MKTG_DIRECTOR','PENDING_SC_DIRECTOR',
        'PENDING_PRODUCTION_AND_ANALYSIS','NEEDS_INFO','REJECTED','CONFIRMED',
      ];
    } else if (roles.includes('MKTG_DIRECTOR')) {
      states = ['PENDING_MKTG_DIRECTOR'];
    } else if (roles.includes('SC_DIRECTOR')) {
      states = ['PENDING_SC_DIRECTOR'];
    } else if (roles.includes('RND_TEAM')) {
      states = ['PENDING_PRODUCTION_AND_ANALYSIS'];
      // R&D's track has THREE forms — production (sequential first), then
      // packaging + design in parallel. Show anything where any of them
      // are still incomplete.
      extraWhere = ' AND (production_completed_at IS NULL OR packaging_completed_at IS NULL OR design_completed_at IS NULL)';
    } else if (roles.includes('MARKETING_TEAM')) {
      states = ['PENDING_PRODUCTION_AND_ANALYSIS'];
      extraWhere = ' AND competitor_completed_at IS NULL';
    } else {
      states = ['DRAFT', 'NEEDS_INFO'];
    }
    const placeholders = states.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT pr.*, u.name AS requestor_full_name
        FROM product_requests pr
        LEFT JOIN users u ON u.id = pr.requestor_user_id
       WHERE pr.workflow_state IN (${placeholders})${extraWhere}
       ORDER BY pr.updated_at DESC
       LIMIT 200
    `).all(...states);

    res.render('products/workflow_queue', {
      requests: rows,
      states,
      stateLabels: productWorkflow.STATE_LABELS,
      viewerRoles: roles,
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
