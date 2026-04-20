// lib/form_schema.js
// -----------------------------------------------------------------------------
// Shared helpers for the form builder:
//   - FIELD_TYPES  : the palette the admin can drop on the canvas
//   - validate     : sanity-check a schema before persisting
//   - renderField  : server-side render of a single field into safe HTML
//   - renderForm   : full form render, ready to POST back to /forms/:id/submit
// -----------------------------------------------------------------------------

const FIELD_TYPES = [
  { type: 'section-header', label: 'Section Header', icon: 'H',  supportsOptions: false, inputLike: false },
  { type: 'text',           label: 'Text',           icon: 'Aa', supportsOptions: false, inputLike: true  },
  { type: 'email',          label: 'Email',          icon: '@',  supportsOptions: false, inputLike: true  },
  { type: 'number',         label: 'Number',         icon: '#',  supportsOptions: false, inputLike: true  },
  { type: 'date',           label: 'Date',           icon: '📅', supportsOptions: false, inputLike: true  },
  { type: 'textarea',       label: 'Long Text',      icon: '¶',  supportsOptions: false, inputLike: true  },
  { type: 'select',         label: 'Dropdown',       icon: '▾',  supportsOptions: true,  inputLike: true  },
  { type: 'radio',          label: 'Radio Group',    icon: '◉',  supportsOptions: true,  inputLike: true  },
  { type: 'yesno',          label: 'Yes / No',       icon: 'Y/N',supportsOptions: false, inputLike: true  },
  { type: 'checkbox',       label: 'Checkbox',       icon: '☑',  supportsOptions: false, inputLike: true  },
];
const VALID_TYPES = new Set(FIELD_TYPES.map((f) => f.type));

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => ({
    '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&#39;',
  }[c]));
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

// Ensure required shape on a schema coming from the builder. Mutates + returns.
function normalize(schema) {
  if (!schema || typeof schema !== 'object') throw new Error('schema_required');
  const fields = Array.isArray(schema.fields) ? schema.fields : [];
  const seen = new Set();
  schema.fields = fields.filter(Boolean).map((f, i) => {
    if (!VALID_TYPES.has(f.type)) throw new Error('unknown_field_type:' + f.type);
    const out = { id: String(f.id || ('f_' + Math.random().toString(36).slice(2, 8))), type: f.type };
    if (f.type === 'section-header') {
      out.label = String(f.label || 'Section');
      return out;
    }
    out.label = String(f.label || `Field ${i + 1}`);
    let name = String(f.name || slug(out.label)) || `field_${i + 1}`;
    // Disambiguate duplicates so req.body stays sane.
    let candidate = name, n = 2;
    while (seen.has(candidate)) { candidate = name + '_' + (n++); }
    seen.add(candidate);
    out.name = candidate;
    out.required = !!f.required;
    out.width = (f.width === 'half') ? 'half' : 'full';
    if (typeof f.placeholder === 'string') out.placeholder = f.placeholder;
    if (typeof f.help === 'string')        out.help = f.help;
    if (f.type === 'textarea' && typeof f.rows === 'number') out.rows = Math.max(2, Math.min(20, f.rows));
    if (f.type === 'number') {
      if (f.min != null && f.min !== '') out.min = Number(f.min);
      if (f.max != null && f.max !== '') out.max = Number(f.max);
    }
    if (f.type === 'select' || f.type === 'radio') {
      const opts = Array.isArray(f.options) ? f.options : [];
      out.options = opts.map((o) => String(o)).filter((o) => o.length > 0);
    }
    return out;
  });
  schema.version = 1;
  schema.name = String(schema.name || '').trim();
  schema.description = String(schema.description || '').trim();
  return schema;
}

// Server-side HTML for one field. Values are the prior submission (or {}).
function renderField(f, values) {
  const v = values || {};
  const req = f.required ? ' required' : '';
  const reqStar = f.required ? '<span class="req">*</span>' : '';
  const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
  const help = f.help ? `<div class="text-xs text-slate-500 mt-1">${esc(f.help)}</div>` : '';
  const value = v[f.name] == null ? '' : String(v[f.name]);
  switch (f.type) {
    case 'section-header':
      return `<h3 class="font-semibold text-slate-800 border-b border-slate-200 pb-1 mt-4 mb-2">${esc(f.label)}</h3>`;
    case 'text':
    case 'email':
    case 'number':
    case 'date':
      return `<label class="field"><span class="label">${reqStar}${esc(f.label)}</span>
        <input type="${f.type}" name="${esc(f.name)}" value="${esc(value)}" class="input"${ph}${req}${f.min != null ? ` min="${esc(f.min)}"` : ''}${f.max != null ? ` max="${esc(f.max)}"` : ''}>
        ${help}</label>`;
    case 'textarea':
      return `<label class="field"><span class="label">${reqStar}${esc(f.label)}</span>
        <textarea name="${esc(f.name)}" rows="${f.rows || 4}" class="input"${ph}${req}>${esc(value)}</textarea>
        ${help}</label>`;
    case 'select': {
      const opts = (f.options || []).map((o) =>
        `<option value="${esc(o)}"${value === o ? ' selected' : ''}>${esc(o)}</option>`
      ).join('');
      return `<label class="field"><span class="label">${reqStar}${esc(f.label)}</span>
        <select name="${esc(f.name)}" class="input"${req}>
          <option value="">— select —</option>${opts}
        </select>${help}</label>`;
    }
    case 'yesno': {
      return `<fieldset class="field"><legend class="label">${reqStar}${esc(f.label)}</legend>
        <label class="mr-3"><input type="radio" name="${esc(f.name)}" value="Yes"${value === 'Yes' ? ' checked' : ''}${req}> Yes</label>
        <label><input type="radio" name="${esc(f.name)}" value="No"${value === 'No' ? ' checked' : ''}> No</label>
        ${help}</fieldset>`;
    }
    case 'radio': {
      const opts = (f.options || []).map((o) =>
        `<label class="mr-3"><input type="radio" name="${esc(f.name)}" value="${esc(o)}"${value === o ? ' checked' : ''}${req}> ${esc(o)}</label>`
      ).join('');
      return `<fieldset class="field"><legend class="label">${reqStar}${esc(f.label)}</legend>
        <div class="flex flex-wrap gap-2">${opts}</div>${help}</fieldset>`;
    }
    case 'checkbox':
      return `<label class="flex items-center gap-2 text-sm">
        <input type="checkbox" name="${esc(f.name)}" value="1"${value ? ' checked' : ''}${req}>
        ${reqStar}${esc(f.label)}
        </label>${help}`;
    default:
      return '';
  }
}

function renderForm(schema, values) {
  const parts = (schema.fields || []).map((f) => {
    const span = (f.type === 'section-header' || f.width !== 'half') ? 2 : 1;
    return `<div style="grid-column: span ${span}">${renderField(f, values || {})}</div>`;
  });
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 20px;">${parts.join('\n')}</div>`;
}

module.exports = { FIELD_TYPES, VALID_TYPES, normalize, renderField, renderForm, esc };
