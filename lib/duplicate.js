// Duplicate check & compliance stubs.
// Implements fuzzy matching scenarios (0% / 75% / 100% match) against vendor master.
const db = require('../db/connection');

function normalize(s) {
  return (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ');
}

// Levenshtein similarity (0-1)
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + c);
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

function dupCheckVendor({ legal_name, tax_id, duns, address, country, erp_instance, commodity_code }) {
  const all = db.prepare(`SELECT v.*, va.line1, va.city, va.country as addr_country
                           FROM vendors v LEFT JOIN vendor_addresses va
                             ON va.vendor_id = v.id AND va.address_type='PRIMARY'`).all();
  const scored = all.map(v => {
    const scores = {
      name: similarity(legal_name, v.legal_name),
      tax:  tax_id && v.tax_id ? (normalize(tax_id) === normalize(v.tax_id) ? 1 : 0) : 0,
      duns: duns && v.duns ? (normalize(duns) === normalize(v.duns) ? 1 : 0) : 0,
      addr: similarity(address, v.line1),
      country: (country && v.addr_country && country === v.addr_country) ? 1 : 0,
      erp: (erp_instance && v.erp_instance && erp_instance === v.erp_instance) ? 1 : 0,
      commodity: (commodity_code && v.commodity_code && commodity_code === v.commodity_code) ? 1 : 0,
    };
    // Weighted overall (name 40%, tax 25%, duns 15%, address 10%, others 10%)
    const overall = 0.4 * scores.name + 0.25 * scores.tax + 0.15 * scores.duns +
                    0.10 * scores.addr + 0.03 * scores.country + 0.04 * scores.erp + 0.03 * scores.commodity;
    return { vendor: v, scores, percent: Math.round(overall * 100) };
  });
  scored.sort((a, b) => b.percent - a.percent);

  const exact = scored.find(s => s.scores.name === 1 && s.scores.tax === 1);
  if (exact) {
    return { level: '100_MATCH', message: 'Exact duplicate match found. You cannot proceed.', matches: [exact] };
  }
  const top = scored.slice(0, 5).filter(s => s.percent >= 40);
  if (top.length > 0) {
    return { level: 'PARTIAL', message: `Top ${top.length} possible matches found. You may proceed with caution.`, matches: top };
  }
  return { level: 'NO_MATCH', message: 'No matches found. Proceed.', matches: [] };
}

// MK Denials screening stub — simple watchlist
const MK_WATCHLIST = ['sanctioned co', 'ofac ltd', 'shady holdings', 'badco'];
function mkDenialCheck(legal_name) {
  const n = normalize(legal_name);
  const hits = MK_WATCHLIST.filter(w => n.includes(w));
  if (hits.length > 0) return { match: true, terms: hits, message: `Potential match against watchlist: ${hits.join(', ')}` };
  return { match: false, terms: [], message: 'No matches on watchlist.' };
}

// D&B address validation stub
function dnbValidate(address) {
  // Simulate: returns "validated" with normalized form
  if (!address?.line1 || !address?.country) return { valid: false, message: 'Missing line1/country' };
  return {
    valid: true,
    message: 'Address verified against D&B',
    normalized: {
      line1: address.line1.trim(),
      city: (address.city || '').trim(),
      state: address.state,
      zip: (address.zip || '').trim(),
      country: address.country,
    },
  };
}

module.exports = { dupCheckVendor, mkDenialCheck, dnbValidate, similarity };
