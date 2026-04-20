// lib/vendor_workflow.js
// -----------------------------------------------------------------------------
// Vendor onboarding workflow state machine.
//
// States:
//   DRAFT                 - Initial form being filled (by any user)
//   PENDING_SC_REVIEW     - Submitted, waiting for Supply Chain
//   NEEDS_INFO            - Supply Chain kicked back to requestor for more info
//   REJECTED              - Supply Chain rejected; terminal state, requires
//                           a brand-new submission to restart
//   PENDING_SUPPLIER      - Supply Chain approved; supplier must fill their form
//   PENDING_VENDOR_ADMIN  - Supplier submitted; Vendor Admin fills technical
//   PENDING_LEGAL         - Vendor Admin submitted; Legal runs compliance
//   CONFIRMED             - All stages done; vendor onboarded
//
// Actions (verbs) a caller invokes; each maps to a legal transition:
//   submit                DRAFT                -> PENDING_SC_REVIEW
//   sc_approve            PENDING_SC_REVIEW    -> PENDING_SUPPLIER
//   sc_reject             PENDING_SC_REVIEW    -> REJECTED
//   sc_request_info       PENDING_SC_REVIEW    -> NEEDS_INFO
//   resubmit              NEEDS_INFO           -> PENDING_SC_REVIEW
//   supplier_submit       PENDING_SUPPLIER     -> PENDING_VENDOR_ADMIN
//   vendor_admin_submit   PENDING_VENDOR_ADMIN -> PENDING_LEGAL
//   legal_approve         PENDING_LEGAL        -> CONFIRMED
//   legal_reject          PENDING_LEGAL        -> REJECTED
//
// Each transition is role-gated. Role names are the uppercase strings the
// auth layer stores on req.user.role.
// -----------------------------------------------------------------------------

const STATES = Object.freeze({
  DRAFT:                'DRAFT',
  PENDING_SC_REVIEW:    'PENDING_SC_REVIEW',
  NEEDS_INFO:           'NEEDS_INFO',
  REJECTED:             'REJECTED',
  PENDING_SUPPLIER:     'PENDING_SUPPLIER',
  PENDING_VENDOR_ADMIN: 'PENDING_VENDOR_ADMIN',
  PENDING_LEGAL:        'PENDING_LEGAL',
  CONFIRMED:            'CONFIRMED',
});

const ROLES = Object.freeze({
  REQUESTOR:    'REQUESTOR',     // any authenticated user starting an onboarding
  SUPPLY_CHAIN: 'SUPPLY_CHAIN',
  SUPPLIER:     'SUPPLIER',
  VENDOR_ADMIN: 'VENDOR_ADMIN',
  LEGAL:        'LEGAL',
  ADMIN:        'ADMIN',         // superuser — can do anything
});

// Human-readable labels for the UI.
const STATE_LABELS = Object.freeze({
  DRAFT:                'Draft',
  PENDING_SC_REVIEW:    'Pending Supply Chain review',
  NEEDS_INFO:           'Needs more information',
  REJECTED:             'Rejected',
  PENDING_SUPPLIER:     'Pending supplier form',
  PENDING_VENDOR_ADMIN: 'Pending Vendor Admin form',
  PENDING_LEGAL:        'Pending Legal review',
  CONFIRMED:            'Confirmed — vendor onboarded',
});

// Transitions table: action -> { from, to, allowed_roles }.
const TRANSITIONS = Object.freeze({
  submit: {
    from: [STATES.DRAFT],
    to:   STATES.PENDING_SC_REVIEW,
    allowed_roles: [ROLES.REQUESTOR, ROLES.ADMIN],
    label: 'Submit for Supply Chain review',
  },
  sc_approve: {
    from: [STATES.PENDING_SC_REVIEW],
    to:   STATES.PENDING_SUPPLIER,
    allowed_roles: [ROLES.SUPPLY_CHAIN, ROLES.ADMIN],
    label: 'Approve (send to supplier)',
  },
  sc_reject: {
    from: [STATES.PENDING_SC_REVIEW],
    to:   STATES.REJECTED,
    allowed_roles: [ROLES.SUPPLY_CHAIN, ROLES.ADMIN],
    label: 'Reject (terminal)',
  },
  sc_request_info: {
    from: [STATES.PENDING_SC_REVIEW],
    to:   STATES.NEEDS_INFO,
    allowed_roles: [ROLES.SUPPLY_CHAIN, ROLES.ADMIN],
    label: 'Request more info from requestor',
  },
  resubmit: {
    from: [STATES.NEEDS_INFO],
    to:   STATES.PENDING_SC_REVIEW,
    allowed_roles: [ROLES.REQUESTOR, ROLES.ADMIN],
    label: 'Resubmit after updates',
  },
  supplier_submit: {
    from: [STATES.PENDING_SUPPLIER],
    to:   STATES.PENDING_VENDOR_ADMIN,
    allowed_roles: [ROLES.SUPPLIER, ROLES.ADMIN],
    label: 'Submit supplier form',
  },
  vendor_admin_submit: {
    from: [STATES.PENDING_VENDOR_ADMIN],
    to:   STATES.PENDING_LEGAL,
    allowed_roles: [ROLES.VENDOR_ADMIN, ROLES.ADMIN],
    label: 'Submit Vendor Admin form',
  },
  legal_approve: {
    from: [STATES.PENDING_LEGAL],
    to:   STATES.CONFIRMED,
    allowed_roles: [ROLES.LEGAL, ROLES.ADMIN],
    label: 'Approve — complete onboarding',
  },
  legal_reject: {
    from: [STATES.PENDING_LEGAL],
    to:   STATES.REJECTED,
    allowed_roles: [ROLES.LEGAL, ROLES.ADMIN],
    label: 'Reject on compliance grounds',
  },
});

// Which role owns a given state (i.e. whose queue it sits in).
const STATE_OWNER = Object.freeze({
  DRAFT:                ROLES.REQUESTOR,
  PENDING_SC_REVIEW:    ROLES.SUPPLY_CHAIN,
  NEEDS_INFO:           ROLES.REQUESTOR,
  REJECTED:             null,
  PENDING_SUPPLIER:     ROLES.SUPPLIER,
  PENDING_VENDOR_ADMIN: ROLES.VENDOR_ADMIN,
  PENDING_LEGAL:        ROLES.LEGAL,
  CONFIRMED:            null,
});

// Which page a user should be routed to given a vendor's current state.
// Value is a relative path expecting :id substitution upstream.
const STATE_VIEW = Object.freeze({
  DRAFT:                '/vendors/:id/edit',
  PENDING_SC_REVIEW:    '/vendors/:id/workflow/supply-chain-review',
  NEEDS_INFO:           '/vendors/:id/edit',
  REJECTED:             '/vendors/:id/workflow/confirmation',
  PENDING_SUPPLIER:     '/vendors/:id/workflow/supplier',
  PENDING_VENDOR_ADMIN: '/vendors/:id/workflow/vendor-admin',
  PENDING_LEGAL:        '/vendors/:id/workflow/legal',
  CONFIRMED:            '/vendors/:id/workflow/confirmation',
});

// Can a given role perform a given action against a vendor in a given state?
function canDo(action, currentState, userRole) {
  const t = TRANSITIONS[action];
  if (!t) return false;
  if (!t.from.includes(currentState)) return false;
  if (!t.allowed_roles.includes(userRole)) return false;
  return true;
}

// List every action available to this user on this vendor right now.
function availableActions(currentState, userRole) {
  return Object.entries(TRANSITIONS)
    .filter(([, t]) => t.from.includes(currentState) && t.allowed_roles.includes(userRole))
    .map(([name, t]) => ({ name, label: t.label, to: t.to }));
}

// Apply a transition. Returns { ok, nextState, error? }.
// The caller is responsible for persisting the new state.
function transition(action, currentState, userRole) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, error: 'UNKNOWN_ACTION' };
  if (!t.from.includes(currentState)) {
    return { ok: false, error: 'ILLEGAL_TRANSITION', detail:
      `Action "${action}" requires state in [${t.from.join(', ')}] — current state is "${currentState}".` };
  }
  if (!t.allowed_roles.includes(userRole)) {
    return { ok: false, error: 'FORBIDDEN', detail:
      `Role "${userRole}" is not allowed to "${action}".` };
  }
  return { ok: true, nextState: t.to };
}

function stateLabel(state) {
  return STATE_LABELS[state] || state;
}

function ownerOf(state) {
  return STATE_OWNER[state] || null;
}

function viewFor(state, vendorId) {
  const tmpl = STATE_VIEW[state];
  if (!tmpl) return null;
  return tmpl.replace(':id', encodeURIComponent(vendorId));
}

module.exports = {
  STATES,
  ROLES,
  STATE_LABELS,
  TRANSITIONS,
  STATE_OWNER,
  STATE_VIEW,
  canDo,
  availableActions,
  transition,
  stateLabel,
  ownerOf,
  viewFor,
};
