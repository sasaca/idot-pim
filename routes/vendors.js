const express = require('express');
const path = require('path');
const multer = require('multer');
const db = require('../db/connection');
const wf = require('../lib/workflow');
const { dupCheckVendor, mkDenialCheck, dnbValidate } = require('../lib/duplicate');
const { similarity, digitsOnly } = require('../lib/fuzzy');
const workflowConfig = require('../lib/workflow_config');
const router = express.Router();

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads_store');
const uploadOnboarding = multer({ dest: uploadDir });

// Columns we map body fields directly into. Anything else lands in
// vendors.extra_fields as JSON.
const DIRECT_COLUMNS = new Set([
  'legal_name', 'secondary_alpha_name',
  'duns', 'tax_id', 'parent_duns',
  'category_l1', 'category_l2', 'category_l3', 'category_l4',
  'commodity_code', 'erp_instance', 'line_of_business',
  'currency_code', 'ap_payment_terms', 'e_invoice_flag',
  'primary_contact_name', 'primary_contact_email', 'primary_contact_phone',
]);
const RENAMED_TO_COLUMN = {
  high_level_classification: 'high_level_class',
  factory_or_field_service:  'factory_or_field',
};
const ADDR_FIELDS = new Set([
  'addr_line1','addr_line2','addr_line3','addr_line4',
  'addr_city','addr_state','addr_zip','addr_country',
]);
const CONTROL_FIELDS = new Set(['action']);

// ---------- LIST / SEARCH ----------
router.get('/', (req, res) => {
  const { q, status } = req.query;
  const clauses = []; const args = [];
  if (q) { clauses.push(`(legal_name LIKE ? OR tax_id LIKE ? OR duns LIKE ? OR erp_supplier_id LIKE ?)`);
           args.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); }
  if (status) { clauses.push(`status=?`); args.push(status); }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const vendors = db.prepare(`SELECT * FROM vendors ${where} ORDER BY legal_name LIMIT 200`).all(...args);
  res.render('vendors/list', { vendors });
});

// ---------- DETAIL ----------
router.get('/:id', (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).render('error', { error: { message: 'Vendor not found' }});
  v.flags = (() => { try { return JSON.parse(v.flags_json || '{}'); } catch { return {}; } })();
  const addresses = db.prepare(`SELECT * FROM vendor_addresses WHERE vendor_id=?`).all(v.id);
  const banks = db.prepare(`SELECT * FROM vendor_banks WHERE vendor_id=?`).all(v.id);
  const history = db.prepare(`SELECT id, wf_id, request_type, status, created_at, completed_at
                              FROM requests WHERE domain='VENDOR' AND subject_id=? ORDER BY id DESC`).all(v.id);
  res.render('vendors/detail', { vendor: v, addresses, banks, history });
});

// ---------- NEW (onboarding) ----------
router.get('/new/onboarding', (req, res) => {
  res.render('vendors/new_onboarding', { ref: loadRef() });
});

router.post('/new/onboarding', uploadOnboarding.any(), (req, res) => {
  const b = req.body;
  const actor = res.locals.currentUser;
  const isDraft = b.action === 'save_draft';

  let risk = 'LOW';
  if (b.work_at_site === 'Yes' && b.physical_work_at_site === 'Yes') risk = 'HIGH';
  else if (b.conflict_of_interest === 'Yes' || b.importer_of_record === 'Yes') risk = 'MEDIUM';

  const extra = {};
  for (const [k, v] of Object.entries(b)) {
    if (DIRECT_COLUMNS.has(k)) continue;
    if (Object.prototype.hasOwnProperty.call(RENAMED_TO_COLUMN, k)) continue;
    if (ADDR_FIELDS.has(k)) continue;
    if (CONTROL_FIELDS.has(k)) continue;
    extra[k] = v;
  }
  if ((req.files || []).length) {
    extra._uploaded_files = req.files.map(f => ({
      field: f.fieldname, filename: f.originalname,
      mimetype: f.mimetype, size: f.size, stored_path: f.path,
    }));
  }

  const now = new Date().toISOString();

  // Evaluate the admin-configured workflow against the submitted form data.
  // `enabled` is the ordered list of stages that will run for this vendor.
  const cfg = workflowConfig.loadActive(db);
  const { enabled } = workflowConfig.computeEnabledStages(cfg, b);
  const enabledStagesJson = JSON.stringify(enabled);
  const workflowState = isDraft
    ? 'DRAFT'
    : (enabled[0] || 'CONFIRMED');

  const createVendor = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO vendors (
        legal_name, secondary_alpha_name, duns, tax_id, parent_duns,
        category_l1, category_l2, category_l3, category_l4,
        commodity_code, erp_instance, line_of_business, factory_or_field,
        currency_code, ap_payment_terms, high_level_class, e_invoice_flag,
        primary_contact_name, primary_contact_email, primary_contact_phone,
        status, risk_rating, extra_fields, created_by,
        workflow_state, workflow_updated_at, workflow_updated_by, enabled_stages
      ) VALUES (
        @legal_name, @secondary_alpha_name, @duns, @tax_id, @parent_duns,
        @category_l1, @category_l2, @category_l3, @category_l4,
        @commodity_code, @erp_instance, @line_of_business, @factory_or_field,
        @currency_code, @ap_payment_terms, @high_level_class, @e_invoice_flag,
        @primary_contact_name, @primary_contact_email, @primary_contact_phone,
        'PENDING', @risk, @extra_fields, @created_by,
        @workflow_state, @now, @created_by, @enabled_stages
      )
    `).run({
      legal_name: b.legal_name, secondary_alpha_name: b.secondary_alpha_name,
      duns: b.duns, tax_id: b.tax_id, parent_duns: b.parent_duns,
      category_l1: b.category_l1, category_l2: b.category_l2,
      category_l3: b.category_l3, category_l4: b.category_l4,
      commodity_code: b.commodity_code, erp_instance: b.erp_instance,
      line_of_business: b.line_of_business, factory_or_field: b.factory_or_field_service,
      currency_code: b.currency_code, ap_payment_terms: b.ap_payment_terms,
      high_level_class: b.high_level_classification, e_invoice_flag: b.e_invoice_flag,
      primary_contact_name: b.primary_contact_name,
      primary_contact_email: b.primary_contact_email,
      primary_contact_phone: b.primary_contact_phone,
      risk, extra_fields: JSON.stringify(extra),
      created_by: actor && actor.id, now, workflow_state: workflowState,
      enabled_stages: enabledStagesJson,
    });
    const vendorId = info.lastInsertRowid;

    if (b.addr_line1 || b.addr_city || b.addr_zip) {
      db.prepare(`
        INSERT INTO vendor_addresses
          (vendor_id, address_type, line1, line2, line3, line4, city, state, zip, country)
        VALUES (?, 'PRIMARY', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(vendorId,
        b.addr_line1, b.addr_line2, b.addr_line3, b.addr_line4,
        b.addr_city, b.addr_state, b.addr_zip, b.addr_country);
    }

    if (!isDraft) {
      db.prepare(`
        INSERT INTO vendor_workflow_history
          (vendor_id, action, from_state, to_state, actor_user_id, actor_role)
        VALUES (?, 'submit', 'DRAFT', 'PENDING_SC_REVIEW', ?, 'REQUESTOR')
      `).run(vendorId, actor && actor.id);
    }

    return vendorId;
  });

  const newVendorId = createVendor();
  if (isDraft) return res.redirect(`/vendors/${newVendorId}`);
  return res.redirect(`/vendors/${newVendorId}/workflow/confirmation`);
});

// ---------- MAINTENANCE ACTIONS ----------
router.get('/:id/update/:kind', (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).render('error', { error: { message: 'Vendor not found' }});
  const addresses = db.prepare(`SELECT * FROM vendor_addresses WHERE vendor_id=?`).all(v.id);
  const banks = db.prepare(`SELECT * FROM vendor_banks WHERE vendor_id=?`).all(v.id);
  res.render('vendors/update', { vendor: v, kind: req.params.kind, addresses, banks, ref: loadRef() });
});

router.post('/:id/update/:kind', (req, res) => {
  const v = db.prepare(`SELECT * FROM vendors WHERE id=?`).get(req.params.id);
  if (!v) return res.status(404).render('error', { error: { message: 'Vendor not found' }});
  const kind = req.params.kind;
  const typeMap = {
    address: 'ADDRESS_UPDATE', erp: 'ERP_UPDATE', terms: 'TERMS_UPDATE',
    bank: 'BANK_UPDATE', deactivate: 'DEACTIVATION', reactivate: 'REACTIVATION',
  };
  const requestType = typeMap[kind];
  if (!requestType) return res.status(400).send('Unknown update kind');

  const payload = { ...req.body };
  const r = wf.createRequest({
    domain: 'VENDOR', requestType, subjectId: v.id, payload,
    requestor: res.locals.currentUser,
    title: `${kind.toUpperCase()} — ${v.legal_name}`,
    shortDesc: req.body.reason || '',
  });
  res.redirect(`/requests/${r.id}`);
});

// ---------- ONE-TIME VENDOR ----------
router.get('/new/one-time', (req, res) => {
  res.render('vendors/new_onetime', { ref: loadRef() });
});
router.post('/new/one-time', (req, res) => {
  const b = req.body;
  const r = wf.createRequest({
    domain: 'VENDOR', requestType: 'ONE_TIME', subjectId: null,
    payload: b, requestor: res.locals.currentUser,
    title: `One-Time Vendor: ${b.legal_name}`,
    shortDesc: b.scope_of_work,
  });
  res.redirect(`/requests/${r.id}`);
});

// ---------- API: Duplicate check ----------
router.post('/api/dup-check', express.json(), (req, res) => {
  res.json(dupCheckVendor(req.body || {}));
});

// ---------- API: Adverse media search via Claude + web search ----------
// Legal / compliance team uses this to surface reputational issues about
// the supplier — forced-labor allegations, corruption, sanctions hits,
// major litigation, environmental violations, data breaches, etc.
// Returns a strict structured report.
router.post('/api/adverse-media', express.json(), async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'NO_API_KEY' });

  const b = req.body || {};
  const identity = [
    b.legal_name && `Name: ${b.legal_name}`,
    b.country && `Country: ${b.country}`,
    b.city && `City: ${b.city}`,
    b.tax_id && `Tax ID: ${b.tax_id}`,
    b.duns && `DUNS: ${b.duns}`,
    b.contact_name && `Primary contact: ${b.contact_name}`,
  ].filter(Boolean).join('\n');

  if (!b.legal_name) return res.status(400).json({ error: 'legal_name_required' });

  const findingSchema = {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: [
          'Labor Practices', 'Corruption / Bribery', 'Sanctions / Watchlist',
          'Environmental', 'Financial Irregularities', 'Litigation',
          'Data Security', 'Reputational / Ethics', 'Other',
        ],
      },
      severity: { type: 'string', enum: ['low', 'medium', 'high'] },
      title:    { type: 'string', description: 'Short headline (<= 100 chars).' },
      summary:  { type: 'string', description: '1-2 sentence summary of the issue.' },
      year:     { type: 'string', description: 'Year or date range (optional).' },
      source_hint: { type: 'string', description: 'Publication/domain that reported it (no raw URL).' },
    },
    required: ['category', 'severity', 'title', 'summary'],
  };

  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 6 },
    {
      name: 'report_adverse_media',
      description: 'Emit the structured adverse-media report. Call exactly once.',
      input_schema: {
        type: 'object',
        properties: {
          overall_risk: { type: 'string', enum: ['none', 'low', 'medium', 'high'] },
          summary:      { type: 'string', description: '1-2 sentence overall assessment.' },
          findings:     { type: 'array', items: findingSchema },
          recommendations: { type: 'array', items: { type: 'string' },
                             description: 'Concise next-step actions for Legal.' },
        },
        required: ['overall_risk', 'summary', 'findings'],
      },
    },
  ];

  const userPrompt =
`Conduct an adverse media search on this supplier and report findings.

${identity}

Focus on reputational / compliance concerns that would influence a Legal
review of the vendor: forced labor or unsafe labor practices, corruption or
bribery, sanctions / watchlist hits, environmental violations, major
litigation, financial irregularities, data breaches, and serious ethics
issues.

Use web_search for recent, credible sources (major newspapers, regulators,
court records). Do not fabricate findings — if nothing credible surfaces,
return an empty findings list with overall_risk = "none".

Rules for the structured output:
- Each finding: category from the enum, severity (low/medium/high), a short
  title, a 1-2 sentence summary, the year (if known), and a source_hint
  (publication or domain — NOT a URL).
- overall_risk rolls up the highest severity seen, or "none".
- recommendations: up to 4 short bullets.

Call report_adverse_media exactly once.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 8192,
        system:
          'You are a legal/compliance due-diligence assistant. Be precise, cite plausible publications, and never fabricate issues. ' +
          'After your web searches, emit the structured result by calling report_adverse_media. Do NOT write any preamble, narration, or summary text — the tool call is your ONLY output. Cap findings at 10.',
        tools,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(502).json({ error: 'anthropic', detail: data });
    const block = (data.content || []).find(
      (x) => x.type === 'tool_use' && x.name === 'report_adverse_media'
    );
    const text = (data.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
    if (!block || !block.input || Object.keys(block.input).length === 0) {
      return res.status(502).json({
        error: 'no_report',
        text,
        stop_reason: data.stop_reason,
        blocks: (data.content || []).map((x) => ({ type: x.type, name: x.name })),
      });
    }
    res.json({ result: block.input });
  } catch (err) {
    res.status(500).json({ error: 'internal', message: String(err.message || err) });
  }
});

// ---------- API: Online validation via Claude + web search ----------
// Cross-checks Name / Address / Contact against public sources and returns
// a structured report via a forced tool call.
router.post('/api/online-validate', express.json(), async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'NO_API_KEY' });

  const b = req.body || {};
  const addressText = [b.address_line1, b.address_city, b.address_state, b.address_zip, b.address_country]
    .filter(Boolean).join(', ');
  const contactText = [b.contact_name, b.contact_email, b.contact_phone]
    .filter(Boolean).join(' / ');

  if (!b.legal_name && !addressText && !contactText) {
    return res.status(400).json({ error: 'no_input' });
  }

  const categorySchema = {
    type: 'object',
    properties: {
      status:      { type: 'string', enum: ['match', 'mismatch', 'not_found'] },
      summary:     { type: 'string', description: 'One short line (<= 120 chars).' },
      suggestions: { type: 'array', items: { type: 'string' }, description: 'Short alternatives — only when status is mismatch.' },
    },
    required: ['status', 'summary'],
  };

  const tools = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 4 },
    {
      name: 'report_validation',
      description: 'Emit the structured validation result. Call exactly once.',
      input_schema: {
        type: 'object',
        properties: {
          name:    Object.assign({}, categorySchema, { description: 'Verification of the legal / company name.' }),
          address: Object.assign({}, categorySchema, { description: 'Verification of the street/city/state/zip/country.' }),
          contact: Object.assign({}, categorySchema, { description: 'Verification of the primary contact (name/email/phone).' }),
        },
        required: ['name', 'address', 'contact'],
      },
    },
  ];

  const userPrompt =
`Verify the following supplier identity against authoritative public sources.
Use web_search to confirm — the official company site, SEC filings, or other
reputable references.

Name:    ${b.legal_name || '(none provided)'}
Address: ${addressText || '(none provided)'}
Contact: ${contactText || '(none provided)'}

For each category (name, address, contact):
- "match"       the submitted value clearly matches public information
- "mismatch"    it differs — provide 1-3 short alternative suggestions
- "not_found"   no clear public record (small / private / unknown entity)

Keep each summary to one short sentence. Suggestions must be concise
alternatives (full values, not explanations). Call report_validation exactly
once with the result.`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: 'You are a precise master-data validation assistant. Use web_search to check facts, then emit the structured result. Never guess — when in doubt, mark as not_found.',
        tools,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return res.status(502).json({ error: 'anthropic', detail: data });
    }
    const block = (data.content || []).find(
      (b) => b.type === 'tool_use' && b.name === 'report_validation'
    );
    if (!block) {
      // Capture any text Claude produced for diagnostics.
      const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return res.status(502).json({ error: 'no_report', text });
    }
    res.json({ result: block.input });
  } catch (err) {
    res.status(500).json({ error: 'internal', message: String(err.message || err) });
  }
});

// ---------- API: ERP-side duplicate check ----------
// Fuzzy-matches the incoming identity against erp_suppliers. Tax ID and DUNS
// are exact-compared (digits only); name / address / erp_instance are scored
// with bigram-Dice similarity. An exact Tax ID or DUNS hit pins the score to
// 100 and gets a flag for priority review.
router.post('/api/erp-dup-check', express.json(), (req, res) => {
  const q = req.body || {};
  const qAddr = [
    q.addr_line1, q.addr_city, q.addr_state, q.addr_zip, q.addr_country,
  ].filter(Boolean).join(' ');
  const qTax  = digitsOnly(q.tax_id);
  const qDuns = digitsOnly(q.duns);

  const suppliers = db.prepare('SELECT * FROM erp_suppliers').all();
  const matches = suppliers.map((s) => {
    const supAddr = [s.address_line1, s.city, s.state, s.zip, s.country]
      .filter(Boolean).join(' ');
    const nameSim = similarity(q.legal_name, s.legal_name);
    const addrSim = similarity(qAddr, supAddr);
    const erpSim  = similarity(q.erp_instance, s.erp_instance);
    const taxExact  = !!(qTax  && digitsOnly(s.tax_id) === qTax);
    const dunsExact = !!(qDuns && digitsOnly(s.duns)   === qDuns);
    const flags = [];
    if (taxExact)  flags.push('EXACT_TAX_ID');
    if (dunsExact) flags.push('EXACT_DUNS');
    const score = (taxExact || dunsExact)
      ? 100
      : Math.round((nameSim * 0.6 + addrSim * 0.3 + erpSim * 0.1) * 100);
    return {
      id: s.id,
      legal_name: s.legal_name,
      address: [s.address_line1, s.city, s.state, s.zip, s.country]
        .filter(Boolean).join(', '),
      tax_id: s.tax_id,
      duns: s.duns,
      erp_instance: s.erp_instance,
      erp_supplier_id: s.erp_supplier_id,
      score,
      flags,
      name_similarity:    Math.round(nameSim * 100),
      address_similarity: Math.round(addrSim * 100),
    };
  })
  .filter((m) => m.score >= 50 || m.flags.length > 0)
  .sort((a, b) => b.score - a.score)
  .slice(0, 20);
  res.json({ matches });
});

function loadRef() {
  const byCat = {};
  db.prepare(`SELECT * FROM reference_data WHERE active=1 ORDER BY label`).all().forEach(r => {
    (byCat[r.category] = byCat[r.category] || []).push(r);
  });
  return byCat;
}

module.exports = router;
