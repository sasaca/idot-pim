// lib/product_workflow.js
// -----------------------------------------------------------------------------
// Product creation workflow state machine.
//
// States:
//   DRAFT                   - Stage 1 saved (or in-progress); requestor still
//                             completing the multi-tab Stage 2 detail form.
//   PENDING_MKTG_DIRECTOR   - Details submitted; awaiting Marketing Director.
//   PENDING_SC_DIRECTOR     - Marketing Director approved; awaiting Supply
//                             Chain Director.
//   NEEDS_INFO              - Either approver kicked back to the requestor.
//   REJECTED                - Approver rejected (terminal). New request needed.
//   CONFIRMED               - Both approvals recorded; ready for SAP outbound.
//
// More stages will be appended after this initial slice.
// -----------------------------------------------------------------------------

const STATES = Object.freeze({
  DRAFT:                 'DRAFT',
  PENDING_MKTG_DIRECTOR: 'PENDING_MKTG_DIRECTOR',
  PENDING_SC_DIRECTOR:   'PENDING_SC_DIRECTOR',
  NEEDS_INFO:            'NEEDS_INFO',
  REJECTED:              'REJECTED',
  CONFIRMED:             'CONFIRMED',
});

const ROLES = Object.freeze({
  REQUESTOR:     'REQUESTOR',
  MKTG_DIRECTOR: 'MKTG_DIRECTOR',
  SC_DIRECTOR:   'SC_DIRECTOR',
  ADMIN:         'ADMIN',
});

const STATE_LABELS = Object.freeze({
  DRAFT:                 'Draft',
  PENDING_MKTG_DIRECTOR: 'Pending Marketing Director approval',
  PENDING_SC_DIRECTOR:   'Pending Supply Chain Director approval',
  NEEDS_INFO:            'Needs more information',
  REJECTED:              'Rejected',
  CONFIRMED:             'Confirmed — ready for SAP creation',
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

  // Supply Chain Director (final approval in this slice).
  sc_approve: {
    from: [STATES.PENDING_SC_DIRECTOR],
    to:   STATES.CONFIRMED,
    allowed_roles: [ROLES.SC_DIRECTOR, ROLES.ADMIN],
    label: 'Approve',
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
