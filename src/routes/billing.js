'use strict';

const express = require('express');
const router  = express.Router();
const { getDb }        = require('../db');
const { requireStaff } = require('../auth');
const { serverNow }    = require('../seed');

// ── POST /api/bills  — create bill for a completed session ──
router.post('/', requireStaff, (req, res) => {
  const { sessionId, addons, discount } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const db  = getDb();
  const s   = db.prepare(`
    SELECT s.*, b.deposit_amount, b.deposit_status, b.payment_type, b.id AS bid
    FROM sessions s LEFT JOIN bookings b ON s.booking_id = b.id
    WHERE s.id = ?
  `).get(Number(sessionId));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'completed') return res.status(409).json({ error: 'Session must be completed first' });

  const existing = db.prepare('SELECT * FROM bills WHERE session_id=?').get(s.id);
  if (existing) return res.status(409).json({ error: 'Bill already exists', receiptCode: existing.receipt_code });

  const actualMs  = Math.max(0, (s.end_ts - s.start_ts) - (s.paused_ms || 0));
  const actualMin = Math.max(1, Math.round(actualMs / 60000));
  const base      = Math.round((s.rate_at_session / 60) * actualMin * 100) / 100;

  const addonList    = Array.isArray(addons) ? addons : [];
  const addonsAmount = addonList.reduce((t, a) => t + (parseFloat(a.amount) || 0), 0);
  const discAmt      = Math.max(0, parseFloat(discount) || 0);

  let depositCredit = 0;
  if (s.deposit_status === 'paid' && s.deposit_amount > 0) depositCredit = s.deposit_amount;

  const totalAmount = Math.round((base + addonsAmount - discAmt) * 100) / 100;
  const dueAmount   = Math.max(0, Math.round((totalAmount - depositCredit) * 100) / 100);

  const rcRow = db.prepare("SELECT MAX(CAST(SUBSTR(receipt_code,4) AS INTEGER)) as n FROM bills").get();
  const rcN   = (rcRow && rcRow.n) ? rcRow.n + 1 : 1;
  const rcCode = `RC-${String(rcN).padStart(4,'0')}`;

  const bill = db.transaction(() => {
    db.prepare(`
      INSERT INTO bills(receipt_code,session_id,booking_id,customer_id,table_id,actual_min,
        base_amount,addons_amount,discount,deposit_credit,total_amount,due_amount,status,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(rcCode, s.id, s.booking_id || null, s.customer_id, s.table_id,
           actualMin, base, addonsAmount, discAmt, depositCredit, totalAmount, dueAmount,
           dueAmount <= 0 ? 'paid' : 'unpaid', req.user.userId);
    const b = db.prepare('SELECT * FROM bills WHERE receipt_code=?').get(rcCode);
    for (const a of addonList) {
      if (a.name && parseFloat(a.amount) > 0)
        db.prepare('INSERT INTO bill_addons(bill_id,name,amount) VALUES(?,?,?)').run(b.id, a.name, parseFloat(a.amount));
    }
    return b;
  })();

  res.status(201).json({ bill, receiptCode: rcCode, dueAmount, totalAmount });
});

// ── GET /api/bills/receipt/:code  — receipt JSON (must be before /:id) ──
router.get('/receipt/:code', requireStaff, (req, res) => {
  const db   = getDb();
  const bill = db.prepare('SELECT * FROM bills WHERE receipt_code=?').get(req.params.code);
  if (!bill) return res.status(404).json({ error: 'Receipt not found' });

  const addons   = db.prepare('SELECT * FROM bill_addons WHERE bill_id=?').all(bill.id);
  const payments = db.prepare("SELECT * FROM payments WHERE bill_id=? AND type='session_payment' ORDER BY created_at").all(bill.id);
  const depositPmt = db.prepare("SELECT * FROM payments WHERE (bill_id=? OR booking_id=?) AND type='deposit' ORDER BY created_at LIMIT 1").get(bill.id, bill.booking_id || -1);
  const customer = db.prepare('SELECT * FROM customers WHERE id=?').get(bill.customer_id);
  const table    = db.prepare('SELECT * FROM tables WHERE id=?').get(bill.table_id);
  const session  = db.prepare('SELECT * FROM sessions WHERE id=?').get(bill.session_id);
  const booking  = bill.booking_id ? db.prepare('SELECT * FROM bookings WHERE id=?').get(bill.booking_id) : null;
  const cfg      = db.prepare('SELECT key,value FROM settings').all().reduce((o,r)=>{o[r.key]=r.value;return o;},{});

  res.json({ bill, addons, payments, depositPmt, customer, table, session, booking, settings: cfg });
});

// ── GET /api/bills/:id ──
router.get('/:id', requireStaff, (req, res) => {
  const db   = getDb();
  const bill = req.params.id.startsWith('RC-')
    ? db.prepare('SELECT * FROM bills WHERE receipt_code=?').get(req.params.id)
    : db.prepare('SELECT * FROM bills WHERE id=?').get(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found' });

  const addons   = db.prepare('SELECT * FROM bill_addons WHERE bill_id=?').all(bill.id);
  const payments = db.prepare("SELECT * FROM payments WHERE bill_id=? ORDER BY created_at").all(bill.id);
  res.json({ bill, addons, payments });
});

// ── POST /api/bills/:id/pay  — record payment (append-only) ──
router.post('/:id/pay', requireStaff, (req, res) => {
  const { amount, mode, note } = req.body || {};
  if (!amount || !mode) return res.status(400).json({ error: 'amount and mode required' });

  const db   = getDb();
  const bill = db.prepare('SELECT * FROM bills WHERE id=?').get(Number(req.params.id));
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status === 'paid') return res.status(409).json({ error: 'Bill already fully paid' });

  const paid = parseFloat(amount);
  db.transaction(() => {
    db.prepare(`
      INSERT INTO payments(bill_id,booking_id,customer_id,type,amount,mode,note,created_by)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(bill.id, bill.booking_id || null, bill.customer_id, 'session_payment', paid, mode, note || '', req.user.userId);
    // Reduce due_amount
    const newDue   = Math.max(0, Math.round((bill.due_amount - paid) * 100) / 100);
    const newStatus = newDue <= 0 ? 'paid' : 'partial';
    db.prepare('UPDATE bills SET due_amount=?,status=? WHERE id=?').run(newDue, newStatus, bill.id);
  })();

  const updated = db.prepare('SELECT * FROM bills WHERE id=?').get(bill.id);
  res.json({ message: 'Payment recorded', bill: updated });
});

// ── GET /api/bills/for-session/:sessionId  — convenience lookup ──
router.get('/for-session/:sessionId', requireStaff, (req, res) => {
  const db   = getDb();
  const bill = db.prepare('SELECT * FROM bills WHERE session_id=?').get(Number(req.params.sessionId));
  if (!bill) return res.json({ bill: null });
  const addons   = db.prepare('SELECT * FROM bill_addons WHERE bill_id=?').all(bill.id);
  const payments = db.prepare("SELECT * FROM payments WHERE bill_id=? ORDER BY created_at").all(bill.id);
  res.json({ bill, addons, payments });
});

module.exports = router;
