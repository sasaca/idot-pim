const express = require('express');
const db = require('../db/connection');
const router = express.Router();

router.get('/', (req, res) => {
  const byDomain = db.prepare(`SELECT domain, COUNT(*) n FROM requests GROUP BY domain`).all();
  const byStatus = db.prepare(`SELECT status, COUNT(*) n FROM requests GROUP BY status`).all();
  const byAssignee = db.prepare(`SELECT current_assignee_role role, COUNT(*) n FROM requests
                                  WHERE status IN ('NEW','WIP','PENDING_APPROVAL','AWAITING_INFO') GROUP BY role`).all();
  const byRequestType = db.prepare(`SELECT request_type, COUNT(*) n FROM requests GROUP BY request_type ORDER BY n DESC`).all();
  const slaBreaches = db.prepare(`SELECT id, wf_id, domain, title, current_step, current_assignee_role, sla_due
                                   FROM requests WHERE sla_due < datetime('now') AND status NOT IN ('COMPLETED','REJECTED','CANCELLED')
                                   ORDER BY sla_due ASC LIMIT 50`).all();
  const avgTime = db.prepare(`SELECT domain, AVG( (julianday(completed_at) - julianday(created_at)) * 24 ) avg_hrs
                              FROM requests WHERE completed_at IS NOT NULL GROUP BY domain`).all();
  const topVendorCountries = db.prepare(`SELECT va.country c, COUNT(*) n
                                          FROM vendor_addresses va JOIN vendors v ON v.id = va.vendor_id
                                          WHERE va.address_type='PRIMARY'
                                          GROUP BY va.country ORDER BY n DESC LIMIT 10`).all();
  res.render('reports/index', { byDomain, byStatus, byAssignee, byRequestType, slaBreaches, avgTime, topVendorCountries });
});

module.exports = router;
