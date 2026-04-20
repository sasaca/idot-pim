// routes/vendor_forms.js
// -----------------------------------------------------------------------------
// Vendor-admin-facing view of form templates built for the Vendor Master.
// Mounted at /vendors/forms (ahead of the generic /vendors router so it
// doesn't collide with /:id).
//
//   GET /vendors/forms       — list all forms where domain = 'vendor_master'
//   GET /vendors/forms/:id   — read-only template preview of one form
//
// Access: VENDOR_ADMIN or MASTER_ADMIN.
// -----------------------------------------------------------------------------

const express = require('express');
const db = require('../db/connection');
const formSchema = require('../lib/form_schema');
const router = express.Router();

router.use((req, res, next) => {
  const role = res.locals.currentUser && res.locals.currentUser.role;
  if (role !== 'VENDOR_ADMIN' && role !== 'MASTER_ADMIN') {
    return res.status(403).render('error', {
      error: { message: 'Vendor Admin access required' },
    });
  }
  next();
});

router.get('/', (req, res) => {
  const forms = db.prepare(`
    SELECT f.id, f.name, f.description, f.is_published, f.updated_at,
           f.schema_json,
           (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) AS submission_count
      FROM form_definitions f
     WHERE f.domain = 'vendor_master'
     ORDER BY f.is_published DESC, f.name COLLATE NOCASE
  `).all();
  res.render('vendors/forms_list', { forms });
});

router.get('/:id(\\d+)', (req, res) => {
  const form = db.prepare(`
    SELECT id, name, description, domain, schema_json, is_published, updated_at
      FROM form_definitions WHERE id = ? AND domain = 'vendor_master'
  `).get(req.params.id);
  if (!form) {
    return res.status(404).render('error', {
      error: { message: 'Template not found or not a Vendor Master form' },
    });
  }
  let schema; try { schema = JSON.parse(form.schema_json); } catch { schema = { fields: [] }; }
  res.render('vendors/form_template', {
    form,
    schema,
    renderedHtml: formSchema.renderForm(schema, {}),
  });
});

module.exports = router;
