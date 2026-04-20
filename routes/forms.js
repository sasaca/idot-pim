// routes/forms.js
// -----------------------------------------------------------------------------
// Public-facing routes for user-built forms:
//   GET  /forms                  — list of published forms
//   GET  /forms/:id              — render a published form
//   POST /forms/:id/submit       — capture a submission
//   GET  /forms/submitted/:sid   — confirmation page
// -----------------------------------------------------------------------------

const express = require('express');
const db = require('../db/connection');
const formSchema = require('../lib/form_schema');
const router = express.Router();

router.get('/', (req, res) => {
  const forms = db.prepare(`
    SELECT id, name, description, updated_at
      FROM form_definitions
     WHERE is_published = 1
     ORDER BY name COLLATE NOCASE
  `).all();
  res.render('forms/list', { forms });
});

function loadPublishedForm(id) {
  const row = db.prepare(`
    SELECT id, name, description, schema_json, is_published
      FROM form_definitions WHERE id = ?
  `).get(id);
  if (!row) return null;
  let schema; try { schema = JSON.parse(row.schema_json); } catch { schema = { fields: [] }; }
  return { ...row, schema };
}

router.get('/:id(\\d+)', (req, res) => {
  const form = loadPublishedForm(req.params.id);
  if (!form || !form.is_published) {
    return res.status(404).render('error', { error: { message: 'Form not found or not published' }});
  }
  res.render('forms/show', { form, renderHtml: formSchema.renderForm(form.schema, {}) });
});

router.post('/:id(\\d+)/submit', (req, res) => {
  const form = loadPublishedForm(req.params.id);
  if (!form || !form.is_published) {
    return res.status(404).render('error', { error: { message: 'Form not found or not published' }});
  }
  // Only keep keys that correspond to schema field names — prevents stuffing
  // arbitrary props into the submission record.
  const allowed = new Set((form.schema.fields || [])
    .filter((f) => f.type !== 'section-header')
    .map((f) => f.name));
  const data = {};
  for (const [k, v] of Object.entries(req.body || {})) if (allowed.has(k)) data[k] = v;

  const info = db.prepare(`
    INSERT INTO form_submissions (form_id, data_json, submitted_by, submitted_at)
    VALUES (?, ?, ?, ?)
  `).run(form.id, JSON.stringify(data), res.locals.currentUser && res.locals.currentUser.id, new Date().toISOString());
  res.redirect(`/forms/submitted/${info.lastInsertRowid}`);
});

router.get('/submitted/:sid(\\d+)', (req, res) => {
  const row = db.prepare(`
    SELECT s.id, s.data_json, s.submitted_at, f.name AS form_name, f.id AS form_id
      FROM form_submissions s JOIN form_definitions f ON f.id = s.form_id
     WHERE s.id = ?
  `).get(req.params.sid);
  if (!row) return res.status(404).render('error', { error: { message: 'Submission not found' }});
  let data; try { data = JSON.parse(row.data_json); } catch { data = {}; }
  res.render('forms/submitted', { submission: row, data });
});

module.exports = router;
