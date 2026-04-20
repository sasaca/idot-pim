const express = require('express');
const db = require('../db/connection');
const router = express.Router();

router.get('/', (req, res) => {
  const u = res.locals.currentUser;

  // Tasks assigned to my role (pending)
  const myTasks = db.prepare(`
    SELECT id, wf_id, domain, request_type, status, title, current_step, sla_due, priority, risk, updated_at
    FROM requests
    WHERE current_assignee_role = ? AND status IN ('NEW','WIP','PENDING_APPROVAL','AWAITING_INFO')
    ORDER BY datetime(sla_due) ASC
    LIMIT 15`).all(u.role);

  // Requests I submitted
  const mySubmitted = db.prepare(`
    SELECT id, wf_id, domain, request_type, status, title, current_step, updated_at
    FROM requests WHERE requestor_id=? ORDER BY id DESC LIMIT 10`).all(u.id);

  // KPIs
  const kpi = {
    open: db.prepare(`SELECT COUNT(*) c FROM requests WHERE status IN ('NEW','WIP','PENDING_APPROVAL','AWAITING_INFO','ON_HOLD')`).get().c,
    completed: db.prepare(`SELECT COUNT(*) c FROM requests WHERE status='COMPLETED'`).get().c,
    breaching: db.prepare(`SELECT COUNT(*) c FROM requests WHERE sla_due < datetime('now') AND status NOT IN ('COMPLETED','REJECTED','CANCELLED')`).get().c,
    vendors: db.prepare(`SELECT COUNT(*) c FROM vendors WHERE status='ACTIVE'`).get().c,
    customers: db.prepare(`SELECT COUNT(*) c FROM customers WHERE status='ACTIVE'`).get().c,
    products: db.prepare(`SELECT COUNT(*) c FROM products WHERE lifecycle_status='ACTIVE'`).get().c,
  };

  // By domain chart
  const byDomain = db.prepare(`SELECT domain, COUNT(*) n FROM requests GROUP BY domain`).all();
  const byStatus = db.prepare(`SELECT status, COUNT(*) n FROM requests GROUP BY status`).all();

  const notifications = db.prepare(`
    SELECT n.*, r.wf_id FROM notifications n LEFT JOIN requests r ON r.id = n.request_id
    WHERE n.user_id=? ORDER BY n.id DESC LIMIT 8`).all(u.id);

  res.render('dashboard', { myTasks, mySubmitted, kpi, byDomain, byStatus, notifications });
});

router.post('/notifications/:id/read', (req, res) => {
  db.prepare(`UPDATE notifications SET read_flag=1 WHERE id=? AND user_id=?`).run(req.params.id, res.locals.currentUser.id);
  res.redirect('back');
});

module.exports = router;
