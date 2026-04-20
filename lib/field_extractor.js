// lib/field_extractor.js
// -----------------------------------------------------------------------------
// Parses views/vendors/new_onboarding.ejs at request time to produce the live
// list of form fields that can be referenced as trigger criteria in the
// workflow admin. This means the trigger-picker UI automatically reflects
// whatever is currently in the form — add or remove a field and the picker
// updates on the next page load.
//
// Returns an array of:
//   { name, label, type: 'yesno' | 'select' | 'text', options: string[] }
//
// Skips:
//   - fields whose name ends in `[]` (array inputs, not scalar triggers)
//   - disabled / readonly / hidden inputs
//   - buttons and file inputs
//   - checkboxes that aren't part of a name group with a yes/no shape
// -----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');

const FORM_PATH = path.join(__dirname, '..', 'views', 'vendors', 'new_onboarding.ejs');

// Fields the admin shouldn't build triggers against — either they're
// identifiers / free text with no useful equality semantics, or they're
// control fields not relevant to routing decisions.
const BLOCKLIST = new Set([
  'legal_name', 'secondary_alpha_name',
  'tax_id', 'duns', 'parent_duns', 'parent_number', 'customer_account_number',
  'primary_contact_name', 'primary_contact_email', 'primary_contact_phone',
  'primary_contact_phone_area',
  'addr_line1', 'addr_line2', 'addr_line3', 'addr_line4',
  'addr_city', 'addr_zip',
  'scope_of_work', 'existing_vendor_name',
  'commodity_code', 'e_invoice_onboarding_date',
  'duplicate_check_status', 'perform_duplicate_check',
  'requestor_name', 'requestor_email',
  'action',
]);

function stripEjs(src) {
  // Remove every <% ... %> block (both scriptlets and outputs).
  return src.replace(/<%[\s\S]*?%>/g, '');
}

function sanitizeLabel(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\*/g, '')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Look backwards from `idx` for the *nearest* <label>…</label> block preceding
// the element and return its plain-text contents. Falls back to empty string
// if there's no <label> within ~200 chars of the element.
function findLabelBefore(html, idx) {
  const win = html.slice(Math.max(0, idx - 2000), idx);
  const closeIdx = win.lastIndexOf('</label>');
  if (closeIdx < 0) return '';
  const tailLen = win.length - (closeIdx + '</label>'.length);
  if (tailLen > 200) return '';
  const openIdx = win.lastIndexOf('<label', closeIdx);
  if (openIdx < 0) return '';
  const openEnd = win.indexOf('>', openIdx);
  if (openEnd < 0 || openEnd > closeIdx) return '';
  return sanitizeLabel(win.slice(openEnd + 1, closeIdx));
}

function extractFields() {
  let raw;
  try { raw = fs.readFileSync(FORM_PATH, 'utf8'); }
  catch { return []; }
  const html = stripEjs(raw);
  const out = [];
  const seen = new Set();

  // ---- <select name="X"> ... </select> --------------------------------------
  const selectRe = /<select\s+([^>]*?)>([\s\S]*?)<\/select>/gi;
  let m;
  while ((m = selectRe.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const nameM = attrs.match(/\bname\s*=\s*["']([^"']+)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    if (name.endsWith('[]') || BLOCKLIST.has(name)) continue;
    if (/\b(disabled|hidden)\b/i.test(attrs)) continue;
    if (seen.has(name)) continue;

    const options = [];
    const optRe = /<option(?:\s+[^>]*?value\s*=\s*["']([^"']*)["'])?[^>]*>([\s\S]*?)<\/option>/gi;
    let om;
    while ((om = optRe.exec(inner)) !== null) {
      const v = (om[1] !== undefined) ? om[1] : sanitizeLabel(om[2]);
      if (!v || v.startsWith('--')) continue;
      if (options.indexOf(v) === -1) options.push(v);
    }

    seen.add(name);
    out.push({
      name,
      label: findLabelBefore(html, m.index) || name,
      type: 'select',
      options,
    });
  }

  // ---- <input type="radio" name="X" value="V"> ------------------------------
  const groups = new Map();
  const radioRe = /<input\s+([^>]*?)>/gi;
  while ((m = radioRe.exec(html)) !== null) {
    const attrs = m[1];
    if (!/\btype\s*=\s*["']radio["']/i.test(attrs)) continue;
    const nm = (attrs.match(/\bname\s*=\s*["']([^"']+)["']/) || [])[1];
    const vl = (attrs.match(/\bvalue\s*=\s*["']([^"']+)["']/) || [])[1];
    if (!nm || !vl || nm.endsWith('[]') || BLOCKLIST.has(nm)) continue;
    let g = groups.get(nm);
    if (!g) { g = { values: [], firstIdx: m.index }; groups.set(nm, g); }
    if (g.values.indexOf(vl) === -1) g.values.push(vl);
  }
  for (const [name, g] of groups) {
    if (seen.has(name)) continue;
    const isYesNo = g.values.length === 2 && g.values.includes('Yes') && g.values.includes('No');
    seen.add(name);
    out.push({
      name,
      label: findLabelBefore(html, g.firstIdx) || name,
      type: isYesNo ? 'yesno' : 'select',
      options: isYesNo ? [] : g.values.slice(),
    });
  }

  // ---- text-like inputs (text / email / tel / date / number / textarea) ----
  const textInputRe = /<input\s+([^>]*?)>/gi;
  while ((m = textInputRe.exec(html)) !== null) {
    const attrs = m[1];
    const type  = (attrs.match(/\btype\s*=\s*["']([^"']+)["']/) || [])[1] || 'text';
    if (!/^(text|email|tel|number|date)$/i.test(type)) continue;
    if (/\b(disabled|readonly|hidden)\b/i.test(attrs)) continue;
    const nm = (attrs.match(/\bname\s*=\s*["']([^"']+)["']/) || [])[1];
    if (!nm || nm.endsWith('[]') || BLOCKLIST.has(nm) || seen.has(nm)) continue;
    seen.add(nm);
    out.push({
      name: nm,
      label: findLabelBefore(html, m.index) || nm,
      type: 'text',
      options: [],
    });
  }

  const textareaRe = /<textarea\s+([^>]*?)>/gi;
  while ((m = textareaRe.exec(html)) !== null) {
    const attrs = m[1];
    const nm = (attrs.match(/\bname\s*=\s*["']([^"']+)["']/) || [])[1];
    if (!nm || nm.endsWith('[]') || BLOCKLIST.has(nm) || seen.has(nm)) continue;
    seen.add(nm);
    out.push({
      name: nm,
      label: findLabelBefore(html, m.index) || nm,
      type: 'text',
      options: [],
    });
  }

  // Stable alphabetical order by label for predictable UI.
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

module.exports = { extractFields, FORM_PATH };
