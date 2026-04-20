// lib/workflow_config.js
// -----------------------------------------------------------------------------
// Runtime helpers for the configurable vendor onboarding workflow.
// Paired with the admin UI at /admin/vendor-workflow.
//
// A configuration is an ordered array of stages. Each stage is:
//   { stage, label, triggers: [...], trigger_mode: 'ALL' | 'ANY' }
//
// Each trigger is:
//   { field, operator: 'equals' | 'not_equals' | 'in' | 'not_in', value }
//
// When triggers is empty the stage is always active. Otherwise it is active
// only when the triggers match the submitted form data (req.body).
//
// The known fields that admins can build triggers against are enumerated in
// TRIGGER_FIELDS — keep this in sync with the onboarding form.
// -----------------------------------------------------------------------------

const TRIGGER_FIELDS = [
  { name: 'requestor_legal_entity_region', label: 'Requestor Region',
    type: 'select', options: ['North America', 'EMEA', 'APAC', 'LATAM'] },
  { name: 'requestor_subregion', label: 'Requestor Subregion',
    type: 'select', options: ['North America', 'South America', 'Western Europe', 'Eastern Europe', 'MEA', 'APAC'] },
  { name: 'addr_country', label: 'Vendor Country',
    type: 'select', options: ['United States', 'Canada', 'Mexico', 'United Kingdom', 'Germany', 'France', 'India', 'China', 'Japan', 'Brazil', 'Other'] },
  { name: 'category_l1', label: 'Category Level 1',
    type: 'select', options: ['DIRECT', 'INDIRECT'] },
  { name: 'erp_instance', label: 'ERP Instance',
    type: 'select', options: ['JDE:EUR', 'JDE:NA', 'SAP:EMEA', 'SAP:APAC', 'SAP:NA'] },
  { name: 'line_of_business', label: 'Line of Business',
    type: 'select', options: ['Global', 'Regional', 'Local'] },
  { name: 'high_level_classification', label: 'High-Level Classification',
    type: 'select', options: ['1 - INDIVIDUAL', '2 - CORPORATION', '3 - PARTNERSHIP', '4 - LLC', '5 - GOVERNMENT'] },
  { name: 'e_invoice_flag', label: 'E-Invoice', type: 'yesno' },
  { name: 'conflict_of_interest', label: 'Conflict of Interest', type: 'yesno' },
  { name: 'work_at_site', label: 'Work On-Site', type: 'yesno' },
  { name: 'physical_work_at_site', label: 'Physical Work On-Site', type: 'yesno' },
  { name: 'ctpat_certified', label: 'C-TPAT Certified', type: 'yesno' },
  { name: 'importer_of_record', label: 'We Are Importer of Record', type: 'yesno' },
  { name: 'one_time_activity', label: 'One-Time Activity', type: 'yesno' },
  { name: 'asn_ers', label: 'ASN/ERS', type: 'select', options: ['ASN', 'ERS', 'Neither'] },
  { name: 'f_1099', label: '1099 Reportable', type: 'select', options: ['A1 - Rents', 'A2 - Services', 'A3 - Other Income', 'N/A'] },
];

// yesno fields get a fixed option list in the UI.
const YESNO_OPTIONS = ['Yes', 'No'];

const STAGE_CATALOG = [
  { stage: 'PENDING_SC_REVIEW',    label: 'Supply Chain Review'  },
  { stage: 'PENDING_SUPPLIER',     label: 'Supplier Form'        },
  { stage: 'PENDING_VENDOR_ADMIN', label: 'Vendor Admin Form'    },
  { stage: 'PENDING_LEGAL',        label: 'Legal Review'         },
];

function rowToScenario(row) {
  if (!row) return null;
  let stages;
  try { stages = JSON.parse(row.stages_json); } catch { stages = []; }
  return {
    id: row.id,
    name: row.name,
    is_active: !!row.is_active,
    stages,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function list(db) {
  return db.prepare(
    `SELECT id, name, is_active, stages_json, updated_at, updated_by
       FROM vendor_workflow_config
      ORDER BY is_active DESC, name COLLATE NOCASE ASC, id ASC`
  ).all().map(rowToScenario);
}

function load(db, id) {
  return rowToScenario(
    db.prepare(
      `SELECT id, name, is_active, stages_json, updated_at, updated_by
         FROM vendor_workflow_config WHERE id = ?`
    ).get(id)
  );
}

function loadActive(db) {
  return rowToScenario(
    db.prepare(
      `SELECT id, name, is_active, stages_json, updated_at, updated_by
         FROM vendor_workflow_config
        WHERE is_active = 1
        ORDER BY id DESC LIMIT 1`
    ).get()
  );
}

function saveActive(db, stages, userId) {
  const active = loadActive(db);
  if (!active) return;
  saveStages(db, active.id, stages, userId);
}

function saveStages(db, id, stages, userId) {
  db.prepare(
    `UPDATE vendor_workflow_config
        SET stages_json = ?, updated_at = ?, updated_by = ?
      WHERE id = ?`
  ).run(JSON.stringify(stages), new Date().toISOString(), userId || null, id);
}

function defaultStagesJson() {
  return JSON.stringify(
    STAGE_CATALOG.map((s) => ({ stage: s.stage, label: s.label, triggers: [], trigger_mode: 'ALL' }))
  );
}

function create(db, name, userId, baseStages) {
  const stagesJson = baseStages
    ? JSON.stringify(baseStages)
    : defaultStagesJson();
  const info = db.prepare(
    `INSERT INTO vendor_workflow_config (name, is_active, stages_json, updated_at, updated_by)
     VALUES (?, 0, ?, ?, ?)`
  ).run(String(name).trim(), stagesJson, new Date().toISOString(), userId || null);
  return load(db, info.lastInsertRowid);
}

function rename(db, id, name) {
  db.prepare(
    `UPDATE vendor_workflow_config SET name = ?, updated_at = ? WHERE id = ?`
  ).run(String(name).trim(), new Date().toISOString(), id);
}

function activate(db, id) {
  const txn = db.transaction(() => {
    db.prepare(`UPDATE vendor_workflow_config SET is_active = 0`).run();
    db.prepare(`UPDATE vendor_workflow_config SET is_active = 1 WHERE id = ?`).run(id);
  });
  txn();
}

function remove(db, id) {
  const row = load(db, id);
  if (!row) return { ok: false, error: 'not_found' };
  if (row.is_active) return { ok: false, error: 'cannot_delete_active' };
  db.prepare(`DELETE FROM vendor_workflow_config WHERE id = ?`).run(id);
  return { ok: true };
}

function duplicate(db, id, name, userId) {
  const row = load(db, id);
  if (!row) return null;
  return create(db, name || (row.name + ' (copy)'), userId, row.stages);
}

// Normalize an incoming form value for comparison (trim, coerce to string).
function norm(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).join(',');
  return String(v).trim();
}

function evaluateTrigger(trigger, data) {
  const actual = norm(data[trigger.field]);
  const op     = trigger.operator || 'equals';
  const expect = Array.isArray(trigger.value)
    ? trigger.value.map((x) => String(x).trim())
    : norm(trigger.value);

  switch (op) {
    case 'equals':      return actual === expect;
    case 'not_equals':  return actual !== expect;
    case 'in':          return Array.isArray(expect) ? expect.includes(actual) : actual === expect;
    case 'not_in':      return Array.isArray(expect) ? !expect.includes(actual) : actual !== expect;
    default:            return false;
  }
}

function evaluateStage(stageCfg, data) {
  const triggers = Array.isArray(stageCfg.triggers) ? stageCfg.triggers : [];
  if (triggers.length === 0) return true;
  const mode = (stageCfg.trigger_mode || 'ALL').toUpperCase();
  if (mode === 'ANY') return triggers.some((t) => evaluateTrigger(t, data));
  return triggers.every((t) => evaluateTrigger(t, data));
}

// Returns { order: [stageName, ...], enabled: [stageName, ...] }
// `order` is the full configured sequence; `enabled` is the subset whose
// triggers matched the submitted form data.
function computeEnabledStages(config, data) {
  const stages = (config && config.stages) || [];
  const order   = stages.map((s) => s.stage);
  const enabled = stages.filter((s) => evaluateStage(s, data)).map((s) => s.stage);
  return { order, enabled };
}

// Given a list of enabled stage names (in configured order) and the current
// state, return the next enabled state after currentState. If there is none,
// returns null (caller treats that as "workflow complete").
function nextEnabledAfter(orderedEnabled, currentState) {
  if (!Array.isArray(orderedEnabled) || orderedEnabled.length === 0) return null;
  const idx = orderedEnabled.indexOf(currentState);
  if (idx < 0)                     return orderedEnabled[0];
  if (idx >= orderedEnabled.length - 1) return null;
  return orderedEnabled[idx + 1];
}

module.exports = {
  TRIGGER_FIELDS,    // legacy fallback — prefer lib/field_extractor for live list
  YESNO_OPTIONS,
  STAGE_CATALOG,
  list,
  load,
  loadActive,
  saveActive,
  saveStages,
  create,
  rename,
  activate,
  remove,
  duplicate,
  evaluateTrigger,
  evaluateStage,
  computeEnabledStages,
  nextEnabledAfter,
};
