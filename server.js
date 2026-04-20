// iDOT Product Information Management — main server
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const db = require('./db/connection');

// First-run seed
const seeded = db.prepare(`SELECT COUNT(*) c FROM users`).get();
if ((seeded?.c || 0) === 0) {
  console.log('[boot] first run — seeding database');
  require('./db/seed');
}

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'idot-pim-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
}));

// Make current user & helpers available to all views
app.use((req, res, next) => {
  const userId = req.session.userId;
  res.locals.currentUser = userId
    ? db.prepare(`SELECT * FROM users WHERE id=?`).get(userId)
    : null;
  // Shim so middleware that expects req.user.role (vendor workflow) works
  // with this app's session-based auth.
  req.user = res.locals.currentUser || null;
  res.locals.query = req.query;
  res.locals.path = req.path;
  res.locals.unreadCount = userId
    ? (db.prepare(`SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read_flag=0`).get(userId)?.c || 0)
    : 0;
  res.locals.fmtDate = (d) => d ? new Date(d.replace(' ','T')+'Z').toLocaleString() : '';
  res.locals.statusClass = (s) => ({
    NEW: 'bg-slate-100 text-slate-700',
    WIP: 'bg-blue-100 text-blue-700',
    PENDING_APPROVAL: 'bg-amber-100 text-amber-700',
    AWAITING_INFO: 'bg-orange-100 text-orange-700',
    ON_HOLD: 'bg-rose-100 text-rose-700',
    COMPLETED: 'bg-emerald-100 text-emerald-700',
    CANCELLED: 'bg-gray-200 text-gray-700',
    REJECTED: 'bg-red-100 text-red-700',
    ACTIVE: 'bg-emerald-100 text-emerald-700',
    PENDING: 'bg-amber-100 text-amber-700',
    INACTIVE: 'bg-gray-200 text-gray-700',
  }[s] || 'bg-slate-100 text-slate-700');
  next();
});

// Auth guard
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

// Vendor onboarding workflow (new request lifecycle).
// Mounted BEFORE the generic /vendors router — the latter has a /:id
// catch-all that would otherwise swallow /vendors/queue and
// /vendors/:id/workflow/*.
const vendorWorkflow = require('./routes/vendor_workflow');
app.use('/vendors/queue',        requireAuth, vendorWorkflow.makeQueueRouter(db));
app.use('/vendors/:id/workflow', requireAuth, vendorWorkflow(db));

// Routes
app.use('/', require('./routes/auth'));
app.use('/dashboard', requireAuth, require('./routes/dashboard'));
app.use('/requests', requireAuth, require('./routes/requests'));
app.use('/vendors', requireAuth, require('./routes/vendors'));
app.use('/customers', requireAuth, require('./routes/customers'));
app.use('/products', requireAuth, require('./routes/products'));
app.use('/portal', requireAuth, require('./routes/portal'));
app.use('/reports', requireAuth, require('./routes/reports'));
app.use('/admin', requireAuth, require('./routes/admin'));
app.use('/forms', requireAuth, require('./routes/forms'));
app.use('/api', requireAuth, require('./routes/api'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/address', require('./routes/address'));

app.get('/', (req, res) => {
  if (req.session.userId) return res.redirect('/dashboard');
  res.redirect('/login');
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { error: err });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\niDOT Product Information Management`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Demo logins: requestor@demo.com, admin@demo.com, sc.manager@demo.com, legal@demo.com,`);
  console.log(`                  finance@demo.com, sales@demo.com, supplier@example.com, customer@example.com`);
  console.log(`  → Password: any value (demo mode)\n`);
});
