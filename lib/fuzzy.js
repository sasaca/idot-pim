// lib/fuzzy.js
// -----------------------------------------------------------------------------
// Bigram Dice-coefficient similarity with light normalization for company
// names. Returns a 0..1 score. Also exposes digitsOnly() for normalizing
// identifiers like Tax ID / DUNS # before an exact comparison.
// -----------------------------------------------------------------------------

const SUFFIX_RE =
  /\b(inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|llc|limited|plc|gmbh|ag|sa|nv|lp|llp|sas|the)\b/gi;

function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(SUFFIX_RE, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.substr(i, 2));
  return set;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const A = normalize(a);
  const B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  if (A.length < 2 || B.length < 2) return 0;
  const ga = bigrams(A);
  const gb = bigrams(B);
  let common = 0;
  ga.forEach((g) => { if (gb.has(g)) common++; });
  return (2 * common) / (ga.size + gb.size);
}

function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}

module.exports = { normalize, bigrams, similarity, digitsOnly };
