// lib/product_workflow.js
// -----------------------------------------------------------------------------
// Product creation workflow state machine.
//
// States:
//   DRAFT                          - Stage 1 saved (or in-progress); requestor
//                                    still completing the multi-tab Stage 2
//                                    detail form.
//   PENDING_MKTG_DIRECTOR          - Details submitted; awaiting Marketing
//                                    Director approval.
//   PENDING_SC_DIRECTOR            - Marketing Director approved; awaiting
//                                    Supply Chain Director approval.
//   PENDING_PRODUCTION_AND_ANALYSIS - Both directors approved. Two teams now
//                                    work in parallel: R&D fills Production
//                                    (Plan / Packaging / Formula) and
//                                    Marketing fills Competitor Analysis. The
//                                    request only advances when both have
//                                    submitted (tracked via timestamp columns
//                                    on the row).
//   NEEDS_INFO                     - Either approver kicked back to the
//                                    requestor.
//   REJECTED                       - Approver rejected (terminal).
//   CONFIRMED                      - Production + Competitor analysis both
//                                    submitted. Ready for SAP outbound.
//
// More stages will be appended after this slice.
// -----------------------------------------------------------------------------

const STATES = Object.freeze({
  DRAFT:                          'DRAFT',
  PENDING_MKTG_DIRECTOR:          'PENDING_MKTG_DIRECTOR',
  PENDING_SC_DIRECTOR:            'PENDING_SC_DIRECTOR',
  PENDING_PRODUCTION_AND_ANALYSIS:'PENDING_PRODUCTION_AND_ANALYSIS',
  PENDING_BOM:                    'PENDING_BOM',
  NEEDS_INFO:                     'NEEDS_INFO',
  REJECTED:                       'REJECTED',
  CONFIRMED:                      'CONFIRMED',
});

const ROLES = Object.freeze({
  REQUESTOR:      'REQUESTOR',
  MKTG_DIRECTOR:  'MKTG_DIRECTOR',
  SC_DIRECTOR:    'SC_DIRECTOR',
  RND_TEAM:       'RND_TEAM',
  MARKETING_TEAM: 'MARKETING_TEAM',
  ADMIN:          'ADMIN',
});

const STATE_LABELS = Object.freeze({
  DRAFT:                          'Draft',
  PENDING_MKTG_DIRECTOR:          'Pending Marketing Director approval',
  PENDING_SC_DIRECTOR:            'Pending Supply Chain Director approval',
  PENDING_PRODUCTION_AND_ANALYSIS:'Production & competitor analysis in progress',
  PENDING_BOM:                    'Pending R&D BOM selection',
  NEEDS_INFO:                     'Needs more information',
  REJECTED:                       'Rejected',
  CONFIRMED:                      'Confirmed — ready for SAP creation',
});

// Reasons offered to approvers when they reject or request more info.
// Used to drive the dropdown in the approval forms; the rationale textarea
// is always optional.
const REJECT_REASONS = Object.freeze([
  'Insufficient market justification',
  'Conflicts with existing product portfolio',
  'Pricing not competitive',
  'BOM / formula concerns',
  'Forecast volumes unrealistic',
  'Brand / category mismatch',
  'Other',
]);

const INFO_REASONS = Object.freeze([
  'Need additional R&D / formula detail',
  'Clarify launch plan / timing',
  'Provide updated forecast volumes',
  'Provide competitor & positioning detail',
  'Confirm contract status / supplier',
  'Other',
]);

// action -> { from[], to, allowed_roles, label }
const TRANSITIONS = Object.freeze({
  // Requestor submits the Stage 2 detail form.
  submit_details: {
    from: [STATES.DRAFT, STATES.NEEDS_INFO],
    to:   STATES.PENDING_MKTG_DIRECTOR,
    allowed_roles: [ROLES.REQUESTOR, ROLES.ADMIN],
    label: 'Submit for Marketing Director approval',
  },

  // Marketing Director.
  mktg_approve: {
    from: [STATES.PENDING_MKTG_DIRECTOR],
    to:   STATES.PENDING_SC_DIRECTOR,
    allowed_roles: [ROLES.MKTG_DIRECTOR, ROLES.ADMIN],
    label: 'Approve (forward to Supply Chain Director)',
  },
  mktg_reject: {
    from: [STATES.PENDING_MKTG_DIRECTOR],
    to:   STATES.REJECTED,
    allowed_roles: [ROLES.MKTG_DIRECTOR, ROLES.ADMIN],
    label: 'Reject',
  },
  mktg_request_info: {
    from: [STATES.PENDING_MKTG_DIRECTOR],
    to:   STATES.NEEDS_INFO,
    allowed_roles: [ROLES.MKTG_DIRECTOR, ROLES.ADMIN],
    label: 'Request more information',
  },

  // Supply Chain Director — opens up the parallel Production + Competitor
  // Analysis stages; the request waits there until both teams submit.
  sc_approve: {
    from: [STATES.PENDING_SC_DIRECTOR],
    to:   STATES.PENDING_PRODUCTION_AND_ANALYSIS,
    allowed_roles: [ROLES.SC_DIRECTOR, ROLES.ADMIN],
    label: 'Approve (open Production & Competitor Analysis)',
  },

  // Post-approval work. R&D's track has TWO sequential forms (Production
  // then Packaging Materials); Marketing's track has ONE (Competitor
  // Analysis). The request only advances to CONFIRMED once all three
  // completion timestamps are set.
  //
  // Each submit transition is fired by the route handler — the route logic
  // picks the "_final" variant when its submit closes the LAST outstanding
  // flag, otherwise the "_partial" variant which stays in the same state.
  //
  // Production — never confirms on its own; once it submits, BOTH
  // Packaging Materials and Design unlock for R&D in parallel.
  submit_production: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_PRODUCTION_AND_ANALYSIS,
    allowed_roles: [ROLES.RND_TEAM, ROLES.ADMIN],
    label: 'Submit Production (Packaging & Design now open)',
  },
  // Packaging Materials. The route handler picks "_final" only when this
  // submit is the LAST of the four completion flags to fire.
  submit_packaging_partial: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_PRODUCTION_AND_ANALYSIS,
    allowed_roles: [ROLES.RND_TEAM, ROLES.ADMIN],
    label: 'Submit Packaging Materials (other tracks still pending)',
  },
  submit_packaging_final: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_BOM,
    allowed_roles: [ROLES.RND_TEAM, ROLES.ADMIN],
    label: 'Submit Packaging Materials (final — opens BOM selection)',
  },
  // Design — runs in parallel with Packaging in R&D's track.
  submit_design_partial: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_PRODUCTION_AND_ANALYSIS,
    allowed_roles: [ROLES.RND_TEAM, ROLES.ADMIN],
    label: 'Submit Design (other tracks still pending)',
  },
  submit_design_final: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_BOM,
    allowed_roles: [ROLES.RND_TEAM, ROLES.ADMIN],
    label: 'Submit Design (final — opens BOM selection)',
  },
  // Competitor Analysis (Marketing). Final only when production +
  // packaging + design are all already complete.
  submit_competitor_partial: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_PRODUCTION_AND_ANALYSIS,
    allowed_roles: [ROLES.MARKETING_TEAM, ROLES.ADMIN],
    label: 'Submit Competitor Analysis (other tracks still pending)',
  },
  submit_competitor_final: {
    from: [STATES.PENDING_PRODUCTION_AND_ANALYSIS],
    to:   STATES.PENDING_BOM,
    allowed_roles: [ROLES.MARKETING_TEAM, ROLES.ADMIN],
    label: 'Submit Competitor Analysis (final — opens BOM selection)',
  },

  // R&D's final step. Confirms the request once the BOM is locked in.
  submit_bom: {
    from: [STATES.PENDING_BOM],
    to:   STATES.CONFIRMED,
    allowed_roles: [ROLES.RND_TEAM, ROLES.ADMIN],
    label: 'Submit BOM (confirms request)',
  },
  sc_reject: {
    from: [STATES.PENDING_SC_DIRECTOR],
    to:   STATES.REJECTED,
    allowed_roles: [ROLES.SC_DIRECTOR, ROLES.ADMIN],
    label: 'Reject',
  },
  sc_request_info: {
    from: [STATES.PENDING_SC_DIRECTOR],
    to:   STATES.NEEDS_INFO,
    allowed_roles: [ROLES.SC_DIRECTOR, ROLES.ADMIN],
    label: 'Request more information',
  },
});

// Return the legal transition for an action + current state, throwing if
// the action is not defined or not legal from the given state.
function transition(currentState, action) {
  const t = TRANSITIONS[action];
  if (!t) throw Object.assign(new Error('UNKNOWN_ACTION: ' + action), { code: 'UNKNOWN_ACTION' });
  if (!t.from.includes(currentState)) {
    throw Object.assign(
      new Error(`ILLEGAL_TRANSITION: ${action} not allowed from ${currentState}`),
      { code: 'ILLEGAL_TRANSITION', from: currentState, action }
    );
  }
  return { action, fromState: currentState, nextState: t.to };
}

function isTerminal(state) {
  return state === STATES.CONFIRMED || state === STATES.REJECTED;
}

module.exports = {
  STATES,
  ROLES,
  STATE_LABELS,
  TRANSITIONS,
  REJECT_REASONS,
  INFO_REASONS,
  transition,
  isTerminal,
};
