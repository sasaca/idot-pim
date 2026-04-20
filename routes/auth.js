const express = require('express');
const db = require('../db/connection');
const router = express.Router();

router.get('/login', (req, res) => {
  const users = db.prepare(`SELECT id, email, name, role FROM users WHERE active=1 ORDER BY role`).all();
  res.render('auth/login', { users, error: null });
});

router.post('/login', (req, res) => {
  const { email } = req.body;
  const u = db.prepare(`SELECT * FROM users WHERE email=? AND active=1`).get(email);
  if (!u) {
    const users = db.prepare(`SELECT id, email, name, role FROM users WHERE active=1`).all();
    return res.render('auth/login', { users, error: 'No such user. Pick one from the list.' });
  }
  req.session.userId = u.id;
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
