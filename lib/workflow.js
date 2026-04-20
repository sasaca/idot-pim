// Workflow engine: defines workflows per (domain, request_type) and advances state.
// Supports conditional steps (e.g. LATAM-only, EU-only, SOX-triggered supervisor),
// reason codes on REJECT / REQUEST_INFO, and segregation-of-duties enforcement.
const db = require('../db/connection');

// ---------- COUNTRY / FIELD CLASSIFICATIONS ----------
const LATAM_COUNTRIES = ['AR','BO','BR','CL','CO','CR','CU','DO','EC','SV','GT','HT','HN','JM','MX','NI','PA','PY','PE','PR','TT','UY','VE'];
const EU_COUNTRIES    = ['AT','BE','CZ','DK','FI','FR','DE','GR','HU','IE','IT','LU','NL','NO','PL','PT','RO','ES','SE','CH','GB'];

// SOX-sensitive fields in the customer master (modifications trigger Supervisor review)
const SOX_FIELDS = ['tax_id','credit_limit','payment_terms','bank_account','iban','legal_name','name_1','name_2','name_3','name_4'];
// GXP-sensitive fields (modifications trigger Quality Regulatory review)
const GXP_FIELDS = ['quality_class','gxp_flag','regulatory_market'];

// Helper predicates callable from conditional step definitions
const cond = {
  isLATAM:   (ctx) => LATAM_COUNTRIES.includes((ctx.payload?.country || ctx.subject?.country || '').toUpperCase()),
  isEU:      (ctx) => EU_COUNTRIES.includes((ctx.payload?.country || ctx.subject?.country || '').toUpperCase()),
  isSoldTo:  (ctx) => /SOLD_TO|END_TO_END/.test(ctx.payload?.partner_function || ''),
  isSoldOrPayer: (ctx) => /SOLD_TO|PAYER|END_TO_END/.test(ctx.payload?.partner_function || ''),
  isPermanent: (ctx) => (ctx.payload?.reactivation_mode || '').toUpperCase() === 'PERMANENT',
  // SOX Supervisor review triggers on MODIFICATIONS to sensitive fields.
  // Callers must include a `changed_fields` array in payload; onboarding does not.
  soxEdited: (ctx) => {
    const changed = ctx.payload?.changed_fields;
    return Array.isArray(changed) && changed.some(f => SOX_FIELDS.includes(f));
  },
  gxpEdited: (ctx) => {
    const changed = ctx.payload?.changed_fields;
    return Array.isArray(changed) && changed.some(f => GXP_FIELDS.includes(f));
  },
  updateNameOrAddress: (ctx) => ['NAME','ADDRESS','TAX_ID'].includes((ctx.payload?.change_type || '').toUpperCase()),
  updatePayTerms:      (ctx) => (ctx.payload?.change_type || '').toUpperCase() === 'PAYMENT_TERMS',
  isPayer:             (ctx) => /PAYER/.test(ctx.payload?.partner_function || '') && !/SOLD_TO/.test(ctx.payload?.partner_function || ''),
};

// ---------- WORKFLOW DEFINITIONS ----------
// Each step: { name, role, optional?, condition? (ctx) => bool }
const FLOWS = {
  VENDOR: {
    ONBOARDING: [
      { name: 'Initial Submission', role: 'BU_REQUESTOR' },
      { name: 'Supply Chain Review', role: 'SUPPLY_CHAIN' },
      { name: 'BU Requestor – Complete Onboarding Form', role: 'BU_REQUESTOR' },
      { name: 'Admin – NDA & Compliance Review', role: 'MASTER_ADMIN' },
      { name: 'Legal – MK Denials / Adverse Media', role: 'LEGAL', optional: true },
      { name: 'Supplier – Self-Service Form', role: 'SUPPLIER' },
      { name: 'Admin – ERP Fields, Compliance, Bank Approval', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    ADDRESS_UPDATE: [
      { name: 'Submit Address Update', role: 'BU_REQUESTOR' },
      { name: 'Legal – MK Denial (if match)', role: 'LEGAL', optional: true },
      { name: 'Admin – Validate & Approve', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    ERP_UPDATE: [
      { name: 'Submit ERP Update', role: 'BU_REQUESTOR' },
      { name: 'Admin – Review & Approve', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    TERMS_UPDATE: [
      { name: 'Submit Terms Update', role: 'BU_REQUESTOR' },
      { name: 'Supply Chain – Approve Terms', role: 'SUPPLY_CHAIN' },
      { name: 'Admin – Approve', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    BANK_UPDATE: [
      { name: 'Submit Bank Update', role: 'BU_REQUESTOR' },
      { name: 'Supplier – Provide Bank Info', role: 'SUPPLIER' },
      { name: 'Admin – Bank Validation & Approval', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    DEACTIVATION: [
      { name: 'Submit Deactivation', role: 'BU_REQUESTOR' },
      { name: 'Admin – Deactivation Checklist', role: 'MASTER_ADMIN' },
      { name: 'Supply Chain – Approve', role: 'SUPPLY_CHAIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    REACTIVATION: [
      { name: 'Submit Reactivation', role: 'BU_REQUESTOR' },
      { name: 'Supply Chain – Approve', role: 'SUPPLY_CHAIN' },
      { name: 'Admin – Compliance Recheck', role: 'MASTER_ADMIN' },
      { name: 'Legal – MK Denial (if match)', role: 'LEGAL', optional: true },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    ONE_TIME: [
      { name: 'Submit One-Time Vendor', role: 'BU_REQUESTOR' },
      { name: 'Supply Chain – Approve', role: 'SUPPLY_CHAIN' },
      { name: 'BU Requestor – Duplicate & MK Denials', role: 'BU_REQUESTOR' },
      { name: 'Legal – MK Denial (if match)', role: 'LEGAL', optional: true },
      { name: 'Admin – ERP & Bank Approval', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
  },
  CUSTOMER: {
    // Customer Creation (New) — full BRD-aligned flow
    ONBOARDING: [
      { name: 'Customer Service – Initiate Request', role: 'CUSTOMER_SERVICE' },
      { name: 'MDM – Review & Supplement', role: 'MDM_TEAM' },
      { name: 'Quality Regulatory – Review', role: 'QUALITY_REG' },
      { name: 'Corp Security – LATAM Review', role: 'CORP_SECURITY', condition: cond.isLATAM },
      { name: 'Credit Management – Payment Terms & Credit Limit', role: 'CREDIT_MGMT', condition: cond.isSoldTo },
      { name: 'Financial Management – Approve', role: 'FIN_MGMT', condition: cond.isSoldOrPayer },
      { name: 'Sales – Input Sales Information', role: 'SALES' },
      { name: 'MDM – Final Review', role: 'MDM_TEAM' },
      { name: 'Supervisor – SOX Review', role: 'SUPERVISOR', condition: cond.soxEdited },
      { name: 'Finance – EU Final Approval', role: 'FIN_MGMT', condition: cond.isEU },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    // Customer Extension
    CUSTOMER_EXTENSION: [
      { name: 'Sales – Initiate Extension', role: 'SALES' },
      { name: 'MDM – Review & Supplement', role: 'MDM_TEAM' },
      { name: 'Quality Regulatory – Review', role: 'QUALITY_REG' },
      { name: 'Credit Management – Payment Terms & Credit Limit', role: 'CREDIT_MGMT', condition: cond.isSoldTo },
      { name: 'Financial Management – Approve', role: 'FIN_MGMT', condition: cond.isSoldOrPayer },
      { name: 'MDM – Final Review', role: 'MDM_TEAM' },
      { name: 'Supervisor – SOX Review', role: 'SUPERVISOR', condition: cond.soxEdited },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    // Customer Block
    CUSTOMER_BLOCK: [
      { name: 'Requestor – Initiate Block', role: 'CUSTOMER_SERVICE' },
      { name: 'MDM – Review Block Checklist', role: 'MDM_TEAM' },
      { name: 'Supervisor – SOX Review', role: 'SUPERVISOR', condition: cond.soxEdited },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    // Customer Reactivation
    CUSTOMER_REACTIVATION: [
      { name: 'Sales – Initiate Reactivation', role: 'SALES' },
      { name: 'MDM – Review Reactivation Checklist', role: 'MDM_TEAM' },
      { name: 'Quality Regulatory – Review', role: 'QUALITY_REG', condition: cond.isPermanent },
      { name: 'Credit Management – Confirm Terms', role: 'CREDIT_MGMT', condition: cond.isPermanent },
      { name: 'Financial Management – Approve Reactivation', role: 'FIN_MGMT' },
      { name: 'MDM – Final Review', role: 'MDM_TEAM' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    // Customer Modification (change_type in payload determines conditional approvals)
    CUSTOMER_UPDATE: [
      { name: 'Sales – Initiate Update', role: 'SALES' },
      { name: 'MDM – Review & Supplement', role: 'MDM_TEAM' },
      { name: 'Quality Regulatory – Review', role: 'QUALITY_REG', condition: cond.updateNameOrAddress },
      { name: 'Credit Management – Review Terms', role: 'CREDIT_MGMT', condition: cond.updatePayTerms },
      { name: 'Financial Management – Approve', role: 'FIN_MGMT', condition: cond.updatePayTerms },
      { name: 'Sales – Input Sales Information', role: 'SALES' },
      { name: 'MDM – Final Review', role: 'MDM_TEAM' },
      { name: 'Supervisor – SOX Review', role: 'SUPERVISOR', condition: cond.soxEdited },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    COMPANY_CODE_EXT: [
      { name: 'Submit Company Code Extension', role: 'BU_REQUESTOR' },
      { name: 'MDM – Review', role: 'MDM_TEAM' },
      { name: 'Financial Management – Approve', role: 'FIN_MGMT' },
      { name: 'MDM – Activate', role: 'MDM_TEAM' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    SALES_AREA_EXT: [
      { name: 'Submit Sales Area Extension', role: 'SALES' },
      { name: 'MDM – Review', role: 'MDM_TEAM' },
      { name: 'Sales – Approve', role: 'SALES' },
      { name: 'MDM – Activate', role: 'MDM_TEAM' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
  },
  PRODUCT: {
    PRODUCT_CREATE: [
      { name: 'Submit Product Creation', role: 'BU_REQUESTOR' },
      { name: 'Product Owner – Review Technical Details', role: 'PRODUCT_OWNER' },
      { name: 'Admin – Enrich Master Data', role: 'MASTER_ADMIN' },
      { name: 'Finance – Costing Review', role: 'FINANCE', optional: true },
      { name: 'Admin – Activate', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
    PRODUCT_UPDATE: [
      { name: 'Submit Product Update', role: 'BU_REQUESTOR' },
      { name: 'Product Owner – Review', role: 'PRODUCT_OWNER' },
      { name: 'Admin – Review & Activate', role: 'MASTER_ADMIN' },
      { name: 'ERP Integration', role: 'SYSTEM' },
    ],
  },
};

// ---------- REASON CODES (for reject / request-more-info dropdowns) ----------
const REASON_CODES = {
  REJECT: [
    { code: 'QA_REJECT_UNSAT', label: 'QA REJECT — Unsatisfactory qualification documentation' },
    { code: 'CF_REJECT_UNSAT', label: 'Credit/Finance REJECT — Unsatisfactory finance documentation' },
    { code: 'MDM_REJECT_TYPE', label: 'MDM REJECT — Incorrect request type' },
    { code: 'MDM_REJECT_CUST', label: 'MDM REJECT — Incorrect customer number' },
    { code: 'DUPLICATE',       label: 'Duplicate vendor/customer record exists' },
    { code: 'MK_DENIAL_HIT',   label: 'Watchlist (OFAC / MK Denials) match' },
    { code: 'POLICY_VIOLATION',label: 'Policy violation / out of business rule scope' },
    { code: 'OTHER',           label: 'Other (explain in comment)' },
  ],
  REQUEST_INFO: [
    { code: 'QA_RMI_MISSING',  label: 'QA — Missing / insufficient qualification documentation' },
    { code: 'QA_RMI_INCORRECT',label: 'QA — Incorrect qualification documentation' },
    { code: 'QA_RMI_DATA',     label: 'QA — Incorrect data entry vs qualification docs' },
    { code: 'CF_RMI_MISSING',  label: 'Credit/Finance — Missing / insufficient finance documentation' },
    { code: 'CF_RMI_INCORRECT',label: 'Credit/Finance — Incorrect finance documentation' },
    { code: 'CF_RMI_DATA',     label: 'Credit/Finance — Incorrect data entry vs finance docs' },
    { code: 'MDM_RMI_APPROVAL',label: 'MDM — Missing approval (non-iDOT approver)' },
    { code: 'MDM_RMI_MISSING', label: 'MDM — Missing / insufficient documentation' },
    { code: 'MDM_RMI_INCORRECT',label: 'MDM — Incorrect documentation' },
    { code: 'MDM_RMI_DATA_CUST',label: 'MDM — Incorrect data entry vs customer documentation' },
    { code: 'MDM_RMI_DATA_STD', label: 'MDM — Incorrect data entry vs master data standards' },
    { code: 'OTHER',           label: 'Other (explain in comment)' },
  ],
};

// ---------- UTILITY ----------
function getFlow(domain, requestType) {
  const flow = FLOWS[domain] && FLOWS[domain][requestType];
  if (!flow) throw new Error(`No workflow defined for ${domain}/${requestType}`);
  return flow;
}

function getActiveFlow(domain, requestType, ctx) {
  // Filter out conditional steps whose condition evaluates false.
  return getFlow(domain, requestType).filter(step => !step.condition || step.condition(ctx || {}));
}

function buildCtx(req) {
  let payload = {};
  try { payload = JSON.parse(req.payload || '{}'); } catch {}
  return { payload, subject: null, request: req };
}

// Generate human-readable WF ID
function generateWfId(domain) {
  const prefix = { VENDOR: 'VEN', CUSTOMER: 'CUS', PRODUCT: 'PRD' }[domain] || 'REQ';
  const row = db.prepare(`SELECT COUNT(*) c FROM requests WHERE domain=?`).get(domain);
  return `${prefix}-${String((row.c || 0) + 1).padStart(6, '0')}`;
}

function slaDaysFor(domain, stepName) {
  const row = db.prepare(
    `SELECT sla_days FROM sla_config WHERE domain=? AND (stage=? OR assignee_role=?) LIMIT 1`
  ).get(domain, stepName, stepName);
  return row?.sla_days || 3;
}

function addBusinessDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// ------- CREATE REQUEST -------
function createRequest({ domain, requestType, subjectId, payload, requestor, title, shortDesc, risk = 'LOW', priority = 'NORMAL' }) {
  const ctx = { payload: payload || {}, subject: null };
  const flow = getActiveFlow(domain, requestType, ctx);
  const firstStep = flow[0];
  const wfId = generateWfId(domain);
  const sla = addBusinessDays(slaDaysFor(domain, firstStep.name));

  const result = db.prepare(`INSERT INTO requests
    (wf_id, domain, request_type, subject_id, payload, status, priority, risk, current_step, current_assignee_role,
     requestor_id, requestor_name, requestor_email, requestor_region, title, short_description, sla_due)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    wfId, domain, requestType, subjectId, JSON.stringify(payload || {}), 'NEW', priority, risk,
    firstStep.name, firstStep.role,
    requestor?.id || null, requestor?.name || null, requestor?.email || null, requestor?.region || null,
    title || `${domain} ${requestType}`, shortDesc || '', sla
  );

  const reqId = result.lastInsertRowid;
  logStep(reqId, firstStep, 'ASSIGNED', requestor, `Request created by ${requestor?.name || 'system'}`);
  addSystemComment(reqId, `Request ${wfId} created by ${requestor?.name || 'system'}`);
  notifyRole(firstStep.role, reqId, `New ${domain} ${requestType} request ${wfId} assigned`);
  return { id: reqId, wf_id: wfId };
}

// ------- ADVANCE REQUEST -------
function advanceRequest(reqId, action, user, comment = '', reasonCode = null) {
  const req = db.prepare(`SELECT * FROM requests WHERE id=?`).get(reqId);
  if (!req) throw new Error('Request not found');
  const ctx = buildCtx(req);
  const flow = getActiveFlow(req.domain, req.request_type, ctx);
  const idx = flow.findIndex(s => s.name === req.current_step);
  if (idx < 0) throw new Error('Current step not found in workflow');
  const cur = flow[idx];

  // --- Segregation of duties ---
  // Requestor cannot approve their own request.
  if ((action === 'APPROVED') && user?.id && req.requestor_id === user.id && user.role !== 'SYSTEM') {
    throw new Error('Segregation of duties: requestor cannot approve their own request.');
  }
  // MDM-initiated requests require a different MDM member for MDM approval steps.
  if (cur.role === 'MDM_TEAM' && action === 'APPROVED' && req.requestor_id && user?.id) {
    const requestor = db.prepare(`SELECT role FROM users WHERE id=?`).get(req.requestor_id);
    if (requestor && requestor.role === 'MDM_TEAM' && user.id === req.requestor_id) {
      throw new Error('Segregation of duties: an MDM request must be approved by a different MDM team member.');
    }
  }

  const commentWithReason = reasonCode ? `[${reasonCode}] ${comment || ''}` : (comment || '');

  // Record action
  logStep(reqId, cur, action, user, commentWithReason, reasonCode);

  if (action === 'REJECTED') {
    db.prepare(`UPDATE requests SET status='REJECTED', completed_at=datetime('now'), updated_at=datetime('now') WHERE id=?`).run(reqId);
    const reasonLabel = reasonCode ? (REASON_CODES.REJECT.find(r => r.code === reasonCode)?.label || reasonCode) : '';
    addSystemComment(reqId, `Rejected by ${user.name}${reasonLabel ? ' — ' + reasonLabel : ''}: ${comment || '(no comment)'}`);
    if (req.requestor_id) notifyUser(req.requestor_id, reqId, `Your request ${req.wf_id} was rejected: ${reasonLabel}`);
    return;
  }
  if (action === 'REQUESTED_INFO') {
    db.prepare(`UPDATE requests SET status='AWAITING_INFO', updated_at=datetime('now') WHERE id=?`).run(reqId);
    const reasonLabel = reasonCode ? (REASON_CODES.REQUEST_INFO.find(r => r.code === reasonCode)?.label || reasonCode) : '';
    addSystemComment(reqId, `More info requested by ${user.name}${reasonLabel ? ' — ' + reasonLabel : ''}: ${comment || ''}`);
    if (req.requestor_id) notifyUser(req.requestor_id, reqId, `More info needed on ${req.wf_id}: ${reasonLabel}`);
    return;
  }
  if (action !== 'APPROVED' && action !== 'SUBMITTED') return;

  // Advance to next step
  const next = flow[idx + 1];
  if (!next) {
    db.prepare(`UPDATE requests SET status='COMPLETED', current_step=?, completed_at=datetime('now'), updated_at=datetime('now')
                WHERE id=?`).run('DONE', reqId);
    addSystemComment(reqId, `Request completed by ${user.name}`);
    if (req.requestor_id) notifyUser(req.requestor_id, reqId, `Your request ${req.wf_id} has been completed`);
    return;
  }

  if (next.role === 'SYSTEM') {
    runErpIntegration(reqId);
    return;
  }

  const sla = addBusinessDays(slaDaysFor(req.domain, next.name));
  db.prepare(`UPDATE requests SET status='PENDING_APPROVAL', current_step=?, current_assignee_role=?, sla_due=?, updated_at=datetime('now')
              WHERE id=?`).run(next.name, next.role, sla, reqId);
  logStep(reqId, next, 'ASSIGNED', null, `Advanced to ${next.name}`);
  notifyRole(next.role, reqId, `${req.wf_id}: task "${next.name}" assigned to your group`);
}

// ------- ERP INTEGRATION STUB -------
function runErpIntegration(reqId) {
  const req = db.prepare(`SELECT * FROM requests WHERE id=?`).get(reqId);
  const success = Math.random() > 0.05;
  if (success) {
    let erpId = null;
    if (req.domain === 'VENDOR' && req.request_type === 'ONBOARDING') {
      const row = db.prepare(`SELECT COUNT(*) c FROM vendors`).get();
      erpId = 'SUP' + String(row.c + 100).padStart(6, '0');
    } else if (req.domain === 'CUSTOMER' && ['ONBOARDING','CUSTOMER_EXTENSION'].includes(req.request_type)) {
      const row = db.prepare(`SELECT COUNT(*) c FROM customers`).get();
      erpId = 'CUS' + String(row.c + 100).padStart(6, '0');
    }
    db.prepare(`UPDATE requests
                SET status='COMPLETED', current_step='DONE', erp_response_status='SUCCESS',
                    erp_response_desc='Record created/updated in ERP', erp_supplier_id=?,
                    completed_at=datetime('now'), updated_at=datetime('now')
                WHERE id=?`).run(erpId, reqId);
    addSystemComment(reqId, `ERP integration succeeded. Record ID: ${erpId || '(update applied)'}`);
    if (req.requestor_id) notifyUser(req.requestor_id, reqId, `Your request ${req.wf_id} is complete. ERP ID: ${erpId || 'updated'}`);
  } else {
    db.prepare(`UPDATE requests
                SET status='ON_HOLD', erp_response_status='ERROR',
                    erp_response_desc='ERP API returned an error; support task created',
                    updated_at=datetime('now')
                WHERE id=?`).run(reqId);
    addSystemComment(reqId, `ERP integration failed. Support task created.`);
  }
}

function logStep(reqId, step, action, user, comment, reasonCode = null) {
  db.prepare(`INSERT INTO workflow_steps
    (request_id, step_name, step_order, assignee_role, assignee_id, action, comment, reason_code, completed_at)
    VALUES (?,?,?,?,?,?,?,?, CASE WHEN ? IN ('APPROVED','REJECTED','SUBMITTED','COMPLETED') THEN datetime('now') ELSE NULL END)`)
    .run(reqId, step.name, 0, step.role, user?.id || null, action, comment, reasonCode, action);
}

function addSystemComment(reqId, body) {
  db.prepare(`INSERT INTO comments (request_id, user_id, author_name, body, is_system) VALUES (?,?,?,?,1)`)
    .run(reqId, null, 'System', body);
}

function notifyRole(role, reqId, subject) {
  const users = db.prepare(`SELECT id FROM users WHERE role=? AND active=1`).all(role);
  const ins = db.prepare(`INSERT INTO notifications (user_id, request_id, subject) VALUES (?,?,?)`);
  users.forEach(u => ins.run(u.id, reqId, subject));
}

function notifyUser(userId, reqId, subject) {
  db.prepare(`INSERT INTO notifications (user_id, request_id, subject) VALUES (?,?,?)`).run(userId, reqId, subject);
}

function stepsFor(domain, requestType, request) {
  try {
    if (request) return getActiveFlow(domain, requestType, buildCtx(request));
    return getFlow(domain, requestType);
  } catch { return []; }
}

module.exports = {
  FLOWS, REASON_CODES, LATAM_COUNTRIES, EU_COUNTRIES, SOX_FIELDS, GXP_FIELDS,
  createRequest, advanceRequest, stepsFor, getActiveFlow, generateWfId,
};
