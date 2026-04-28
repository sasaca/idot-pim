// middleware/require_product_role.js
// -----------------------------------------------------------------------------
// Role + state gating middleware for the product creation workflow.
//
// Mirrors middleware/require_role.js but talks to lib/product_workflow.js,
// product_requests, and the MKTG_DIRECTOR / SC_DIRECTOR roles. Kept separate
// so the two workflows can evolve independently.
// -----------------------------------------------------------------------------

const { STATES, ROLES } = require('../lib/product_workflow');

function getUserRoles(req) {
  if (!req || !req.user) return [];
  let roles;
  if (typeof req.user.role === 'string') roles = [req.user.role];
  else if (Array.isArray(req.user.roles)) roles = req.user.roles.slice();
  else if (Array.isArray(req.user.role)) roles = req.user.role.slice();
  else return [];
  // App-level superuser → workflow ADMIN.
  if (roles.includes('MASTER_ADMIN') && !roles.includes('ADMIN')) {
    roles.push('ADMIN');
  }
  return roles;
}

function hasAnyRole(req, allowed) {
  const roles = getUserRoles(req);
  if (roles.includes(ROLES.ADMIN)) return true;
  return allowed.some((r) => roles.includes(r));
}

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
      return res.status(403).json({ error: 'FORBIDDEN', required: allowed, have: getUserRoles(req) });
    }
    next();
  };
}

function requireState(...states) {
  return function (req, res, next) {
    const r = res.locals.productRequest;
    if (!r) return res.status(500).json({ error: 'PRODUCT_REQUEST_NOT_LOADED' });
    const cur = r.workflow_state || STATES.DRAFT;
    if (!states.includes(cur)) {
      if (req.accepts('html')) {
        return res.status(409).render('products/workflow_wrong_state', {
          productRequest: r, required: states, current: cur,
        });
      }
      return res.status(409).json({ error: 'WRONG_STATE', required: states, current: cur });
    }
    next();
  };
}

function loadProductRequest(db) {
  return function (req, res, next) {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: 'BAD_PRODUCT_REQUEST_ID' });
      }
      const row = db.prepare('SELECT * FROM product_requests WHERE id = ?').get(id);
      if (!row) return res.status(404).json({ error: 'PRODUCT_REQUEST_NOT_FOUND' });
      res.locals.productRequest = row;
      next();
    } catch (e) { next(e); }
  };
}

module.exports = {
  requireRole,
  requireState,
  loadProductRequest,
  getUserRoles,
  hasAnyRole,
};
