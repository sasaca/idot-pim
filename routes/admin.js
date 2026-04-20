const express = require('express');
const db = require('../db/connection');
const workflowConfig = require('../lib/workflow_config');
const { extractFields } = require('../lib/field_extractor');
const formSchema = require('../lib/form_schema');
const router = express.Router();

router.use((req, res, next) => {
  if (res.locals.currentUser.role !== 'MASTER_ADMIN') {
    return res.status(403).render('error', { error: { message: 'Admin access required' }});
  }
  next();
});

router.get('/', (req, res) => {
  const categories = db.prepare(`SELECT category, COUNT(*) n FROM reference_data GROUP BY category ORDER BY category`).all();
  const users = db.prepare(`SELECT * FROM users ORDER BY role`).all();
  res.render('admin/index', { categories, users });
});

// ---------- Vendor workflow configuration ----------
// Multi-scenario: each row in vendor_workflow_config is a named scenario;
// exactly one is `is_active = 1` and that's the one applied at vendor submit.

router.get('/vendor-workflow', (req, res) => {
  const scenarios = workflowConfig.list(db);
  // Default to showing the active scenario; allow ?id=N to open a different one.
  const wantId = Number(req.query.id);
  const current = (Number.isFinite(wantId) && scenarios.find((s) => s.id === wantId))
    || scenarios.find((s) => s.is_active)
    || scenarios[0]
    || null;

  res.render('admin/vendor_workflow', {
    scenarios,
    currentScenario: current,
    stageCatalog:    workflowConfig.STAGE_CATALOG,
    triggerFields:   extractFields(),         // live from the onboarding form
    yesnoOptions:    workflowConfig.YESNO_OPTIONS,
  });
});

function validateStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    return { ok: false, error: 'stages_required' };
  }
  const allowed = new Set(workflowConfig.STAGE_CATALOG.map((s) => s.stage));
  for (const s of stages) {
    if (!s || !allowed.has(s.stage)) {
      return { ok: false, error: 'unknown_stage', stage: s && s.stage };
    }
    s.triggers = Array.isArray(s.triggers) ? s.triggers : [];
    s.trigger_mode = s.trigger_mode === 'ANY' ? 'ANY' : 'ALL';
  }
  return { ok: true };
}

// Save stages for a specific scenario (falls back to active if id omitted).
router.post('/vendor-workflow', express.json(), (req, res) => {
  const stages = (req.body && req.body.stages) || [];
  const v = validateStages(stages);
  if (!v.ok) return res.status(400).json(v);
  const id = Number(req.body && req.body.id);
  const uid = res.locals.currentUser && res.locals.currentUser.id;
  if (Number.isFinite(id) && id > 0) {
    const row = workflowConfig.load(db, id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    workflowConfig.saveStages(db, id, stages, uid);
  } else {
    workflowConfig.saveActive(db, stages, uid);
  }
  res.json({ ok: true });
});

router.post('/vendor-workflow/new', express.json(), (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  const s = workflowConfig.create(db, name, res.locals.currentUser && res.locals.currentUser.id);
  res.json({ ok: true, scenario: s });
});

router.post('/vendor-workflow/:id/rename', express.json(), (req, res) => {
  const id = Number(req.params.id);
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name_required' });
  if (!workflowConfig.load(db, id)) return res.status(404).json({ error: 'not_found' });
  workflowConfig.rename(db, id, name);
  res.json({ ok: true });
});

router.post('/vendor-workflow/:id/activate', (req, res) => {
  const id = Number(req.params.id);
  if (!workflowConfig.load(db, id)) return res.status(404).json({ error: 'not_found' });
  workflowConfig.activate(db, id);
  res.json({ ok: true });
});

router.post('/vendor-workflow/:id/duplicate', express.json(), (req, res) => {
  const id = Number(req.params.id);
  const name = (req.body && req.body.name) || null;
  const s = workflowConfig.duplicate(db, id, name, res.locals.currentUser && res.locals.currentUser.id);
  if (!s) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, scenario: s });
});

router.post('/vendor-workflow/:id/delete', (req, res) => {
  const id = Number(req.params.id);
  const result = workflowConfig.remove(db, id);
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

router.get('/reference/:category', (req, res) => {
  const items = db.prepare(`SELECT * FROM reference_data WHERE category=? ORDER BY label`).all(req.params.category);
  res.render('admin/reference', { category: req.params.category, items });
});

router.post('/reference/:category', (req, res) => {
  const { code, label, parent } = req.body;
  if (code && label) {
    db.prepare(`INSERT OR REPLACE INTO reference_data (category,code,label,parent,active) VALUES (?,?,?,?,1)`)
      .run(req.params.category, code, label, parent || null);
  }
  res.redirect(`/admin/reference/${req.params.category}`);
});

router.post('/reference/:category/:id/delete', (req, res) => {
  db.prepare(`UPDATE reference_data SET active=0 WHERE id=?`).run(req.params.id);
  res.redirect(`/admin/reference/${req.params.category}`);
});

// ---------- Form builder ----------
router.get('/forms', (req, res) => {
  const forms = db.prepare(`
    SELECT f.id, f.name, f.description, f.domain, f.schema_json, f.is_published,
           f.created_at, f.updated_at,
           u.name AS created_by_name,
           (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submission_count
      FROM form_definitions f LEFT JOIN users u ON u.id = f.created_by
     ORDER BY f.updated_at DESC
  `).all();
  res.render('admin/forms_list', { forms, domainLabel: formSchema.domainLabel });
});

router.get('/forms/new', (req, res) => {
  res.render('admin/form_builder', {
    form: null,
    fieldTypes: formSchema.FIELD_TYPES,
    formDomains: formSchema.FORM_DOMAINS,
  });
});

router.get('/forms/:id', (req, res) => {
  const form = db.prepare(`SELECT * FROM form_definitions WHERE id = ?`).get(req.params.id);
  if (!form) return res.status(404).render('error', { error: { message: 'Form not found' }});
  let schema; try { schema = JSON.parse(form.schema_json); } catch { schema = { fields: [] }; }
  // Carry the row-level domain into the schema object passed to the builder
  // so the UI's domain dropdown is pre-populated correctly.
  schema.domain = form.domain || 'general';
  res.render('admin/form_builder', {
    form: { ...form, schema },
    fieldTypes: formSchema.FIELD_TYPES,
    formDomains: formSchema.FORM_DOMAINS,
  });
});

router.post('/forms', express.json(), (req, res) => {
  let schema;
  try { schema = formSchema.normalize(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!schema.name) return res.status(400).json({ error: 'name_required' });
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO form_definitions (name, description, domain, schema_json, is_published, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(schema.name, schema.description, schema.domain, JSON.stringify(schema),
         res.locals.currentUser.id, now, now);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.post('/forms/:id', express.json(), (req, res) => {
  const row = db.prepare(`SELECT id FROM form_definitions WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  let schema;
  try { schema = formSchema.normalize(req.body || {}); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!schema.name) return res.status(400).json({ error: 'name_required' });
  db.prepare(`
    UPDATE form_definitions
       SET name = ?, description = ?, domain = ?, schema_json = ?, updated_at = ?
     WHERE id = ?
  `).run(schema.name, schema.description, schema.domain,
         JSON.stringify(schema), new Date().toISOString(), req.params.id);
  res.json({ ok: true });
});

router.post('/forms/:id/publish', express.json(), (req, res) => {
  const publish = req.body && req.body.publish ? 1 : 0;
  const info = db.prepare(`UPDATE form_definitions SET is_published = ?, updated_at = ? WHERE id = ?`)
    .run(publish, new Date().toISOString(), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, is_published: !!publish });
});

router.post('/forms/:id/delete', (req, res) => {
  const info = db.prepare(`DELETE FROM form_definitions WHERE id = ?`).run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

router.get('/forms/:id/submissions', (req, res) => {
  const form = db.prepare(`SELECT * FROM form_definitions WHERE id = ?`).get(req.params.id);
  if (!form) return res.status(404).render('error', { error: { message: 'Form not found' }});
  const submissions = db.prepare(`
    SELECT s.id, s.data_json, s.submitted_at, u.name AS submitted_by_name
      FROM form_submissions s LEFT JOIN users u ON u.id = s.submitted_by
     WHERE s.form_id = ?
     ORDER BY s.submitted_at DESC
  `).all(req.params.id);
  let schema; try { schema = JSON.parse(form.schema_json); } catch { schema = { fields: [] }; }
  res.render('admin/form_submissions', { form: { ...form, schema }, submissions });
});

module.exports = router;
