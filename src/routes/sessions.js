'use strict';

const express = require('express');
const router  = express.Router();
const { getDb }        = require('../db');
const { requireStaff } = require('../auth');
const { serverNow }    = require('../seed');
const { checkOverlap, getRate } = require('../overlap');

function settings(db) {
  const rows = db.prepare('SELECT key,value FROM settings').all();
  return rows.reduce((o, r) => { o[r.key] = r.value; return o; }, {});
}

// ── GET /api/sessions  — active/paused sessions ──
router.get('/', requireStaff, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
           t.name AS table_name, b.booking_code
    FROM sessions s
    JOIN customers c ON s.customer_id = c.id
    JOIN tables t    ON s.table_id    = t.id
    LEFT JOIN bookings b ON s.booking_id = b.id
    WHERE s.status IN ('pending','active','paused')
    ORDER BY s.created_at DESC
  `).all();
  const now = serverNow();
  const enriched = rows.map(s => ({ ...s, elapsedMin: calcElapsed(s, now) }));
  res.json({ sessions: enriched, serverNow: now });
});

// ── GET /api/sessions/table/:tableId  — active session on a table ──
router.get('/table/:tableId', requireStaff, (req, res) => {
  const db  = getDb();
  const now = serverNow();
  const s   = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
           t.name AS table_name, b.booking_code, b.deposit_amount,
           b.deposit_status, b.payment_type
    FROM sessions s
    JOIN customers c ON s.customer_id = c.id
    JOIN tables t    ON s.table_id    = t.id
    LEFT JOIN bookings b ON s.booking_id = b.id
    WHERE s.table_id = ? AND s.status IN ('pending','active','paused')
    ORDER BY s.id DESC LIMIT 1
  `).get(Number(req.params.tableId));
  if (!s) return res.json({ session: null, serverNow: now });
  res.json({ session: { ...s, elapsedMin: calcElapsed(s, now) }, serverNow: now });
});

// ── GET /api/sessions/:id ──
router.get('/:id', requireStaff, (req, res) => {
  const db  = getDb();
  const now = serverNow();
  const s   = db.prepare(`
    SELECT s.*, c.name AS customer_name, c.phone AS customer_phone,
           t.name AS table_name, b.booking_code, b.deposit_amount,
           b.deposit_status, b.payment_type, b.end_ts as booking_end_ts
    FROM sessions s
    JOIN customers c ON s.customer_id = c.id
    JOIN tables t    ON s.table_id    = t.id
    LEFT JOIN bookings b ON s.booking_id = b.id
    WHERE s.id = ?
  `).get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  res.json({ session: { ...s, elapsedMin: calcElapsed(s, now) }, serverNow: now });
});

// ── POST /api/sessions/checkin  — check in a booking ──
router.post('/checkin', requireStaff, (req, res) => {
  const { bookingCode } = req.body || {};
  if (!bookingCode) return res.status(400).json({ error: 'bookingCode required' });
  const db  = getDb();
  const bk  = db.prepare('SELECT * FROM bookings WHERE booking_code=?').get(bookingCode);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });
  if (bk.status !== 'confirmed') return res.status(409).json({ error: `Booking is ${bk.status}, not confirmed` });

  const now    = serverNow();
  const result = db.transaction(() => {
    db.prepare('UPDATE bookings SET status=? WHERE id=?').run('checked_in', bk.id);
    db.prepare(`
      INSERT INTO sessions(booking_id,customer_id,table_id,walk_in,checkin_ts,status,rate_at_session,started_by)
      VALUES(?,?,?,0,?,?,?,?)
    `).run(bk.id, bk.customer_id, bk.table_id, now, 'pending', bk.rate_at_booking, req.user.userId);
    const s = db.prepare('SELECT * FROM sessions WHERE booking_id=? ORDER BY id DESC LIMIT 1').get(bk.id);
    db.prepare('UPDATE tables SET status=? WHERE id=?').run('reserved', bk.table_id);
    db.prepare('INSERT INTO activity_log(user_id,customer_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?,?)')
      .run(req.user.userId, bk.customer_id, 'checkin', 'session', s.id, JSON.stringify({ bookingCode }));
    return s;
  })();

  res.json({ message: 'Checked in', session: result });
});

// ── POST /api/sessions/walkin  — walk-in session ──
router.post('/walkin', requireStaff, (req, res) => {
  const { phone, name, tableId } = req.body || {};
  if (!tableId) return res.status(400).json({ error: 'tableId required' });
  if (!phone)   return res.status(400).json({ error: 'phone required' });
  const db  = getDb();
  const tbl = db.prepare('SELECT * FROM tables WHERE id=?').get(Number(tableId));
  if (!tbl) return res.status(404).json({ error: 'Table not found' });
  if (['maintenance','disabled'].includes(tbl.status)) return res.status(409).json({ error: `Table is ${tbl.status}` });

  // Check no active session already
  const active = db.prepare('SELECT id FROM sessions WHERE table_id=? AND status IN (?,?,?)').get(Number(tableId),'pending','active','paused');
  if (active) return res.status(409).json({ error: 'Table already has an active session' });

  const ph = String(phone).trim();
  let cust = db.prepare('SELECT * FROM customers WHERE phone=?').get(ph);
  if (!cust) {
    const n2 = String(name || '').trim();
    if (!n2) return res.status(400).json({ error: 'name required for new customer' });
    const row = db.prepare("SELECT MAX(CAST(SUBSTR(customer_code,3) AS INTEGER)) as n FROM customers").get();
    const n   = (row && row.n) ? row.n + 1 : 1;
    db.prepare('INSERT INTO customers(customer_code,name,phone) VALUES(?,?,?)').run(`C-${String(n).padStart(4,'0')}`, n2, ph);
    cust = db.prepare('SELECT * FROM customers WHERE phone=?').get(ph);
  }

  const now = serverNow();
  const s   = settings(db);
  const { rate } = getRate(tbl, now, s);

  const session = db.transaction(() => {
    db.prepare('UPDATE tables SET status=? WHERE id=?').run('reserved', Number(tableId));
    db.prepare(`
      INSERT INTO sessions(customer_id,table_id,walk_in,checkin_ts,status,rate_at_session,started_by)
      VALUES(?,?,1,?,?,?,?)
    `).run(cust.id, Number(tableId), now, 'pending', rate, req.user.userId);
    return db.prepare('SELECT * FROM sessions WHERE customer_id=? AND walk_in=1 ORDER BY id DESC LIMIT 1').get(cust.id);
  })();

  res.status(201).json({ message: 'Walk-in created', session, customer: cust });
});

// ── POST /api/sessions/:id/start ──
router.post('/:id/start', requireStaff, (req, res) => {
  const db = getDb();
  const s  = db.prepare('SELECT * FROM sessions WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'pending') return res.status(409).json({ error: `Session is ${s.status}` });
  const now = serverNow();
  db.transaction(() => {
    db.prepare('UPDATE sessions SET start_ts=?,status=? WHERE id=?').run(now, 'active', s.id);
    db.prepare('UPDATE tables SET status=? WHERE id=?').run('in_play', s.table_id);
    if (s.booking_id) db.prepare('UPDATE bookings SET status=? WHERE id=?').run('in_play', s.booking_id);
  })();
  res.json({ message: 'Session started', startTs: now });
});

// ── POST /api/sessions/:id/pause ──
router.post('/:id/pause', requireStaff, (req, res) => {
  const db = getDb();
  const s  = db.prepare('SELECT * FROM sessions WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'active') return res.status(409).json({ error: 'Session is not active' });
  const now = serverNow();
  db.prepare('UPDATE sessions SET pause_ts=?,status=? WHERE id=?').run(now, 'paused', s.id);
  res.json({ message: 'Paused', pauseTs: now });
});

// ── POST /api/sessions/:id/resume ──
router.post('/:id/resume', requireStaff, (req, res) => {
  const db = getDb();
  const s  = db.prepare('SELECT * FROM sessions WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status !== 'paused') return res.status(409).json({ error: 'Session is not paused' });
  const now      = serverNow();
  const added    = now - s.pause_ts;
  const pausedMs = (s.paused_ms || 0) + added;
  db.prepare('UPDATE sessions SET paused_ms=?,pause_ts=NULL,status=? WHERE id=?').run(pausedMs, 'active', s.id);
  res.json({ message: 'Resumed', totalPausedMs: pausedMs });
});

// ── POST /api/sessions/:id/extend ──
router.post('/:id/extend', requireStaff, (req, res) => {
  const extra = parseInt((req.body || {}).extraMinutes, 10);
  if (!extra || extra <= 0) return res.status(400).json({ error: 'extraMinutes must be a positive number' });
  const db = getDb();
  const s  = db.prepare('SELECT * FROM sessions WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (!['active','paused'].includes(s.status)) return res.status(409).json({ error: 'Session not active' });

  const cfg      = settings(db);
  const bufferMs = parseInt(cfg.booking_buffer_min, 10) * 60000;
  const now      = serverNow();

  // Compute current projected end
  let currentEnd;
  if (s.booking_id) {
    const bk   = db.prepare('SELECT end_ts FROM bookings WHERE id=?').get(s.booking_id);
    currentEnd = bk.end_ts;
  } else {
    currentEnd = now; // walk-in: extension is from now
  }
  const newEnd = currentEnd + extra * 60000;

  // Check next booking after current end
  const next = db.prepare(`
    SELECT * FROM bookings
    WHERE table_id=? AND status IN ('confirmed','checked_in') AND start_ts > ?
    ORDER BY start_ts ASC LIMIT 1
  `).get(s.table_id, now);

  if (next && newEnd + bufferMs > next.start_ts) {
    const at = new Date(next.start_ts).toLocaleTimeString('en-IN', {
      timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false
    });
    return res.status(409).json({ error: `Blocked by booking ${next.booking_code} at ${at}` });
  }

  db.transaction(() => {
    db.prepare('UPDATE sessions SET extended_min=extended_min+? WHERE id=?').run(extra, s.id);
    if (s.booking_id) db.prepare('UPDATE bookings SET end_ts=end_ts+? WHERE id=?').run(extra * 60000, s.booking_id);
  })();

  res.json({ message: `Extended by ${extra} min`, newEnd });
});

// ── POST /api/sessions/:id/end ──
router.post('/:id/end', requireStaff, (req, res) => {
  const db = getDb();
  const s  = db.prepare('SELECT * FROM sessions WHERE id=?').get(Number(req.params.id));
  if (!s) return res.status(404).json({ error: 'Session not found' });
  if (s.status === 'completed') return res.status(409).json({ error: 'Session already completed' });

  const now      = serverNow();
  let pausedMs   = s.paused_ms || 0;
  if (s.status === 'paused' && s.pause_ts) pausedMs += now - s.pause_ts;

  db.transaction(() => {
    db.prepare('UPDATE sessions SET end_ts=?,paused_ms=?,status=?,ended_by=? WHERE id=?')
      .run(now, pausedMs, 'completed', req.user.userId, s.id);
    db.prepare('UPDATE tables SET status=? WHERE id=?').run('available', s.table_id);
    if (s.booking_id) db.prepare('UPDATE bookings SET status=? WHERE id=?').run('completed', s.booking_id);
  })();

  const startTs  = s.start_ts || now;
  const actualMs = Math.max(0, (now - startTs) - pausedMs);
  const actualMin = Math.max(1, Math.round(actualMs / 60000));
  res.json({ message: 'Session ended', sessionId: s.id, actualMin, endTs: now });
});

// ── helper ──
function calcElapsed(s, now) {
  if (!s.start_ts) return 0;
  const endRef   = s.end_ts || now;
  let pausedMs   = s.paused_ms || 0;
  if (s.status === 'paused' && s.pause_ts) pausedMs += now - s.pause_ts;
  return Math.max(0, Math.round(((endRef - s.start_ts) - pausedMs) / 60000));
}

module.exports = router;
