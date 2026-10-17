'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { requireStaff } = require('../auth');
const { serverNow, getSetting, resetDemoData, getOffset, addOffset } = require('../seed');

// GET /api/admin/settings  (owner only — checked in route, not middleware, for simplicity)
router.get('/settings', requireStaff, (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  const db   = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s    = {};
  for (const r of rows) s[r.key] = r.value;
  res.json({ settings: s });
});

// PUT /api/admin/settings  (owner only)
router.put('/settings', requireStaff, (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  const db   = getDb();
  const body = req.body || {};
  const stmt = db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)');
  const update = db.transaction(() => {
    for (const [k, v] of Object.entries(body)) {
      stmt.run(String(k), String(v));
    }
  });
  update();
  res.json({ message: 'Settings updated' });
});

// POST /api/admin/reset  — Reset demo data (owner only)
router.post('/reset', requireStaff, (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  try {
    resetDemoData();
    res.json({ message: 'Demo data reset successfully' });
  } catch (err) {
    console.error('[reset]', err);
    res.status(500).json({ error: 'Reset failed: ' + err.message });
  }
});

// GET /api/admin/clock  — get current server time offset
router.get('/clock', requireStaff, (req, res) => {
  const offset = getOffset();
  res.json({
    serverNow:   serverNow(),
    offsetMs:    offset,
    offsetMin:   Math.round(offset / 60000),
  });
});

// POST /api/admin/clock/forward  — fast-forward server clock (staff+owner)
router.post('/clock/forward', requireStaff, (req, res) => {
  const { minutes } = req.body || {};
  const min = parseInt(minutes, 10);
  if (!min || min <= 0) {
    return res.status(400).json({ error: 'minutes must be a positive number' });
  }
  addOffset(min * 60000);
  const db = getDb();
  db.prepare(`
    INSERT INTO activity_log(user_id,action,entity_type,detail)
    VALUES(?,?,?,?)
  `).run(req.user.userId, 'clock_forward', 'system',
    JSON.stringify({ minutes: min, newOffsetMs: getOffset() }));

  res.json({
    message: `Clock advanced by ${min} minutes`,
    serverNow:  serverNow(),
    offsetMs:   getOffset(),
    offsetMin:  Math.round(getOffset() / 60000),
  });
});

// POST /api/admin/clock/reset
router.post('/clock/reset', requireStaff, (req, res) => {
  const { setOffset } = require('../seed');
  setOffset(0);
  res.json({ message: 'Clock reset to real time', serverNow: serverNow(), offsetMs: 0 });
});

// GET /api/admin/activity-log
router.get('/activity-log', requireStaff, (req, res) => {
  if (req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Owner access required' });
  }
  const db   = getDb();
  const { limit = 100, offset = 0 } = req.query;
  const rows = db.prepare(`
    SELECT a.*, u.username
    FROM activity_log a
    LEFT JOIN users u ON a.user_id = u.id
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset));
  res.json({ logs: rows });
});

// GET /api/admin/customers  (search by name or phone, staff+owner)
router.get('/customers', requireStaff, (req, res) => {
  const { q } = req.query;
  const db = getDb();
  let sql = 'SELECT * FROM customers WHERE 1=1';
  const params = [];
  if (q) {
    sql += ' AND (name LIKE ? OR phone LIKE ?)';
    const pattern = `%${q}%`;
    params.push(pattern, pattern);
  }
  sql += ' ORDER BY name ASC LIMIT 50';
  const rows = db.prepare(sql).all(...params);
  res.json({ customers: rows });
});

module.exports = router;
