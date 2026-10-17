'use strict';

const express = require('express');
const router  = express.Router();
const { getDb }                           = require('../db');
const { requireStaff, requireCustomer }   = require('../auth');
const { serverNow }                       = require('../seed');

// ── GET /api/customers  — search (staff) ──
router.get('/', requireStaff, (req, res) => {
  const db  = getDb();
  const { q } = req.query;
  let sql = 'SELECT * FROM customers WHERE 1=1';
  const p = [];
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ? OR customer_code LIKE ?)'; const w = `%${q}%`; p.push(w,w,w); }
  sql += ' ORDER BY name LIMIT 50';
  res.json({ customers: db.prepare(sql).all(...p) });
});

// ── GET /api/customers/me/history  — customer self-service ──
router.get('/me/history', requireCustomer, (req, res) => {
  const db    = getDb();
  const cid   = req.customer.customerId;
  const cust  = db.prepare('SELECT * FROM customers WHERE id=?').get(cid);
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  const bookings = db.prepare(`
    SELECT b.*, t.name AS table_name, t.type AS table_type
    FROM bookings b JOIN tables t ON b.table_id=t.id
    WHERE b.customer_id=? ORDER BY b.start_ts DESC
  `).all(cid);

  const bills = db.prepare(`
    SELECT bl.*, t.name AS table_name
    FROM bills bl JOIN tables t ON bl.table_id=t.id
    WHERE bl.customer_id=? ORDER BY bl.created_at DESC
  `).all(cid);

  const payments = db.prepare('SELECT * FROM payments WHERE customer_id=? ORDER BY created_at DESC').all(cid);

  res.json({ customer: cust, bookings, bills, payments, now: serverNow() });
});

// ── GET /api/customers/:id/history  — staff view of customer ledger ──
router.get('/:id/history', requireStaff, (req, res) => {
  const db   = getDb();
  const cust = db.prepare('SELECT * FROM customers WHERE id=?').get(Number(req.params.id));
  if (!cust) return res.status(404).json({ error: 'Customer not found' });

  const bookings = db.prepare(`
    SELECT b.*, t.name AS table_name, t.type AS table_type
    FROM bookings b JOIN tables t ON b.table_id=t.id
    WHERE b.customer_id=? ORDER BY b.start_ts DESC
  `).all(cust.id);

  const bills = db.prepare(`
    SELECT bl.*, t.name AS table_name
    FROM bills bl JOIN tables t ON bl.table_id=t.id
    WHERE bl.customer_id=? ORDER BY bl.created_at DESC
  `).all(cust.id);

  const payments = db.prepare('SELECT * FROM payments WHERE customer_id=? ORDER BY created_at DESC LIMIT 50').all(cust.id);

  const completedVisits = bookings.filter(b => ['completed','in_play','checked_in'].includes(b.status));
  const totalSpend      = bills.reduce((s, b) => s + b.total_amount, 0);
  const totalMin        = bills.reduce((s, b) => s + b.actual_min, 0);
  const lastCompleted   = bookings.find(b => b.status === 'completed');

  res.json({
    customer: cust,
    bookings, bills, payments,
    summary: {
      visitCount:   completedVisits.length,
      totalSpend,
      totalMin,
      lastVisitTs:  lastCompleted ? lastCompleted.start_ts : null,
      noShowCount:  cust.no_show_count,
      cancelCount:  bookings.filter(b => b.status === 'cancelled').length,
      pendingDues:  bills.filter(b => b.status !== 'paid').reduce((s, b) => s + b.due_amount, 0),
    }
  });
});

module.exports = router;
