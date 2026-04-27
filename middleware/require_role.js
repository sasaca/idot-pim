// middleware/require_role.js
// -----------------------------------------------------------------------------
// Role + state gating middleware for the vendor onboarding workflow.
//
// Assumes your auth layer populates req.user with at least { id, role }.
// If your schema stores roles differently (e.g. an array of role names, or
// a join table), adjust getUserRoles() below.
//
// Usage:
//   const { requireRole, requireState } = require('../middleware/require_role');
//   router.get('/supply-chain-review/:id',
//     requireRole('SUPPLY_CHAIN'),
//     requireState('PENDING_SC_REVIEW'),
//     handler);
// -----------------------------------------------------------------------------

const { STATES, ROLES } = require('../lib/vendor_workflow');

// ---- Tune this to match your auth schema ------------------------------------
function getUserRoles(req) {
  if (!req || !req.user) return [];
  let roles;
  // Case 1: req.user.role is a single string.
  if (typeof req.user.role === 'string') roles = [req.user.role];
  // Case 2: req.user.roles is an array of strings.
  else if (Array.isArray(req.user.roles)) roles = req.user.roles.slice();
  // Case 3: req.user.role is an array.
  else if (Array.isArray(req.user.role)) roles = req.user.role.slice();
  else return [];
  // The vendor-onboarding state machine has its own ADMIN superuser role.
  // This app uses MASTER_ADMIN as the equivalent, so alias the two so
  // master admins automatically pass the workflow's role and transition
  // checks (Supply Chain review, Legal decision, etc.).
  if (roles.includes('MASTER_ADMIN') && !roles.includes('ADMIN')) {
    roles.push('ADMIN');
  }
  return roles;
}
// -----------------------------------------------------------------------------

function hasAnyRole(req, allowed) {
  const roles = getUserRoles(req);
  if (roles.includes(ROLES.ADMIN)) return true;     // ADMIN is superuser
  return allowed.some((r) => roles.includes(r));
}

// Require the user to be authenticated AND hold at least one of the given roles.
function requireRole(...allowed) {
  return function (req, res, next) {
    if (!req.user) {
      if (req.accepts('html')) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
      return res.status(401).json({ error: 'UNAUTHENTICATED' });
    }
    if (!hasAnyRole(req, allowed)) {
      if (req.accepts('html')) {
        return res.status(403).render('errors/forbidden', {
          required: allowed.join(' or '),
          have: getUserRoles(req),
        });
      }
      return res.status(403).json({
        error: 'FORBIDDEN',
        required: allowed,
        have: getUserRoles(req),
      });
    }
    next();
  };
}

// Require the vendor record (already loaded as res.locals.vendor) to be in
// one of the listed workflow states. Load the vendor upstream via loadVendor().
function requireState(...states) {
  return function (req, res, next) {
    const v = res.locals.vendor;
    if (!v) {
      return res.status(500).json({ error: 'VENDOR_NOT_LOADED' });
    }
    const cur = v.workflow_state || STATES.DRAFT;
    if (!states.includes(cur)) {
      if (req.accepts('html')) {
        return res.status(409).render('vendors/workflow_wrong_state', {
          vendor: v,
          required: states,
          current: cur,
        });
      }
      return res.status(409).json({
        error: 'WRONG_STATE',
        required: states,
        current: cur,
      });
    }
    next();
  };
}

// Helper to load a vendor into res.locals.vendor from :id. Use as middleware
// before any requireState() call.
function loadVendor(db) {
  return function (req, res, next) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'BAD_VENDOR_ID' });
      }
      const row = db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'VENDOR_NOT_FOUND' });
      res.locals.vendor = row;
      next();
    } catch (e) {
      next(e);
    }
  };
}

module.exports = {
  requireRole,
  requireState,
  loadVendor,
  getUserRoles,
  hasAnyRole,
};
