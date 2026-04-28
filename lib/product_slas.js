// lib/product_slas.js
// -----------------------------------------------------------------------------
// Service-Level Agreement targets for the product creation workflow. Days
// are wall-clock days; the dashboard compares each open request's time-in-
// state against these to flag breaches.
//
// Sum of all stage SLAs = 30 days end-to-end target.
// -----------------------------------------------------------------------------

const STAGE_SLA_DAYS = Object.freeze({
  DRAFT:                              3,
  PENDING_MKTG_DIRECTOR:              2,
  PENDING_SC_DIRECTOR:                2,
  PENDING_PRODUCTION_AND_ANALYSIS:    7,
  PENDING_BOM:                        5,
  PENDING_RND_AND_QUALITY_DIRECTORS:  3,
  PENDING_LEGAL_AND_MDM:              5,
  NEEDS_INFO:                         3,
});

// Per-role SLAs covering the time the role is responsible for. Used by the
// per-actor performance table (compares avg actor turnaround vs target).
const ROLE_SLA_DAYS = Object.freeze({
  REQUESTOR:        3,
  MKTG_DIRECTOR:    2,
  SC_DIRECTOR:      2,
  RND_TEAM:        12,    // production + packaging + design + BOM combined
  MARKETING_TEAM:   7,
  RND_DIRECTOR:     1.5,
  QUALITY_DIRECTOR: 1.5,
  LEGAL:            4,
  MDM_TEAM:         2,
});

const TOTAL_CYCLE_SLA_DAYS = Object.values(STAGE_SLA_DAYS).reduce((s, d) => s + d, 0);

// Helper — given days_in_state vs sla, return one of:
//   'ok'      green   (< 75% of SLA)
//   'risk'    amber   (75% – 100%)
//   'breach'  red     (> SLA)
function slaStatus(days, sla) {
  if (sla == null) return 'ok';
  if (days > sla)         return 'breach';
  if (days > sla * 0.75)  return 'risk';
  return 'ok';
}

module.exports = { STAGE_SLA_DAYS, ROLE_SLA_DAYS, TOTAL_CYCLE_SLA_DAYS, slaStatus };
