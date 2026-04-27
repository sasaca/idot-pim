// lib/vendor_lookups.js
// -----------------------------------------------------------------------------
// Lookup helpers backed by the data dictionary spreadsheet that ships in
// /data. Used to populate dropdowns and to apply per-role visibility /
// editability rules in the vendor onboarding workflow forms.
//
//   tables(num)       → string[]  options for "Table N"
//   madeUp(name)      → string[]  hand-rolled option lists for fields the
//                                  dictionary marks ref="Pending" or freeform
//   fieldsByForm(form)→ Field[]   field metadata for one of the dictionary's
//                                  sub-forms ("Business Requestor — …" etc.)
//   permFor(field, role) → 'Editable' | 'Display Only' | 'Hide' | 'Autopopulated'
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');

function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf-8'));
}

const TABLES   = loadJson('vendor_tables.json');
const MADE_UP  = loadJson('vendor_made_up_options.json');
const DICT     = loadJson('vendor_field_dictionary.json');
const TAXONOMY = loadJson('vendor_taxonomy.json');   // L1 → L2 → L3 → [L4]
const PHONE_CODES = loadJson('phone_codes.json');    // [{ name, iso2, dial, flag }]
const COUNTRIES_FULL = loadJson('countries_full.json'); // [{ iso2, name, flag }]
const COUNTRY_STATES = loadJson('country_states.json'); // { "Country Name": ["State 1", ...] }
const REGION_SUBREGIONS = loadJson('region_subregions.json'); // { "Region": ["Sub", ...] }

function tableByNum(n) {
  if (n == null) return null;
  return TABLES[String(n)] || null;
}

function tableByRef(refStr) {
  const m = String(refStr || '').match(/Table\s+(\d+)/i);
  return m ? tableByNum(m[1]) : null;
}

function madeUp(name) {
  return MADE_UP[name] || [];
}

function fieldsByForm(formName) {
  const target = String(formName || '').toLowerCase().trim();
  return DICT.fields.filter((f) => String(f.form).toLowerCase().trim() === target);
}

function fieldByLabel(label) {
  return DICT.fields.find((f) => f.label === label);
}

function permFor(field, role) {
  if (!field || !field.perms) return 'Hide';
  return String(field.perms[role] || 'Hide').trim();
}

const ROLE_KEYS = { REQUESTOR: 'R', SUPPLIER: 'V', SUPPLY_CHAIN: 'SC', VENDOR_ADMIN: 'VA' };

module.exports = {
  TABLES,
  MADE_UP,
  DICT,
  TAXONOMY,
  PHONE_CODES,
  COUNTRIES_FULL,
  COUNTRY_STATES,
  REGION_SUBREGIONS,
  ROLE_KEYS,
  tableByNum,
  tableByRef,
  madeUp,
  fieldsByForm,
  fieldByLabel,
  permFor,
};
