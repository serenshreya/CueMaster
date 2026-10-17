'use strict';

const express = require('express');
const router  = express.Router();

const { getDb }       = require('../db');
const { requireStaff, requireCustomer } = require('../auth');
const { serverNow, getSetting }         = require('../seed');
const { checkOverlap, getRate, calcPrice, calcDeposit } = require('../overlap');

/**
 * Helpers
 */
function getAllSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  return s;
}

function validateOperatingHours(db, startTs, endTs) {
  const s = getAllSettings(db);
  const [openH, openM]  = s.opening_hour.split(':').map(Number);
  const [closeH, closeM] = s.closing_hour.split(':').map(Number);

  const toIST = ts => {
    const d = new Date(ts);
    const ist = new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    return ist;
  };

  const startIST = toIST(startTs);
  const endIST   = toIST(endTs);

  const startMin = startIST.getHours() * 60 + startIST.getMinutes();
  const endMin   = endIST.getHours()   * 60 + endIST.getMinutes();

  const openMin  = openH  * 60 + openM;
  const closeMin = closeH * 60 + closeM;

  if (startMin < openMin) return `Start time is before opening hours (${s.opening_hour})`;
  if (endMin   > closeMin) return `End time is after closing hours (${s.closing_hour})`;
  return null;
}

// ────────────────────────────────────────────────────────────
// GET /api/bookings/price  — preview price before booking
// ────────────────────────────────────────────────────────────
router.get('/price', (req, res) => {
  const { tableId, startTs, durationMin } = req.query;
  if (!tableId || !startTs || !durationMin) {
    return res.status(400).json({ error: 'tableId, startTs, durationMin required' });
  }

  const db    = getDb();
  const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(tableId));
  if (!table) return res.status(404).json({ error: 'Table not found' });

  const settings = getAllSettings(db);
  const minDur   = parseInt(settings.min_duration_min, 10);
  const dur      = parseInt(durationMin, 10);

  if (dur < minDur) {
    return res.status(400).json({ error: `Minimum duration is ${minDur} minutes` });
  }

  const start = Number(startTs);
  const end   = start + dur * 60000;
  const { rate, isPeak } = getRate(table, start, settings);
  const amount  = calcPrice(rate, dur);
  const deposit = calcDeposit(amount, settings);

  res.json({ rate, isPeak, amount, deposit, durationMin: dur });
});

// ────────────────────────────────────────────────────────────
// POST /api/bookings  — create a booking (customer OR staff)
// ────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  // Allow both customer-token and staff-token
  // We'll detect which and proceed
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

  const { verifyToken, verifyCustomerToken } = require('../auth');
  let actorCustomerId = null;
  let actorUserId     = null;

  if (token) {
    const staffPayload    = verifyToken(token);
    const customerPayload = verifyCustomerToken(token);
    if (staffPayload)    { actorUserId = staffPayload.userId; }
    else if (customerPayload) { actorCustomerId = customerPayload.customerId; }
  }

  if (!actorCustomerId && !actorUserId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { tableId, startTs, durationMin, paymentType, name, phone } = req.body || {};

  if (!tableId || !startTs || !durationMin) {
    return res.status(400).json({ error: 'tableId, startTs, durationMin required' });
  }

  const db = getDb();
  const settings = getAllSettings(db);
  const bufferMs = parseInt(settings.booking_buffer_min, 10) * 60000;
  const minDur   = parseInt(settings.min_duration_min, 10);
  const dur      = parseInt(durationMin, 10);

  if (dur < minDur) {
    return res.status(400).json({ error: `Minimum duration is ${minDur} minutes` });
  }

  const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(tableId));
  if (!table) return res.status(404).json({ error: 'Table not found' });
  if (table.status === 'disabled' || table.status === 'maintenance') {
    return res.status(409).json({ error: `Table ${table.name} is not available (${table.status})` });
  }

  const start = Number(startTs);
  const end   = start + dur * 60000;

  // Operating hours check
  const hoursErr = validateOperatingHours(db, start, end);
  if (hoursErr) return res.status(400).json({ error: hoursErr });

  // Must book in the future
  const now = serverNow();
  if (start < now) {
    return res.status(400).json({ error: 'Cannot book in the past' });
  }

  // Determine customer
  let customerId = actorCustomerId;
  if (actorUserId) {
    // Staff creating for a customer — phone required
    if (!phone) return res.status(400).json({ error: 'phone required when staff creates a booking' });
    const ph = String(phone).trim();
    let cust = db.prepare('SELECT * FROM customers WHERE phone = ?').get(ph);
    if (!cust) {
      const custName = String(name || '').trim();
      if (!custName) return res.status(400).json({ error: 'name required for new customer' });
      const row = db.prepare("SELECT MAX(CAST(SUBSTR(customer_code,3) AS INTEGER)) as n FROM customers").get();
      const n   = (row && row.n) ? row.n + 1 : 1;
      const code = `C-${String(n).padStart(4,'0')}`;
      db.prepare("INSERT INTO customers(customer_code,name,phone) VALUES(?,?,?)").run(code, custName, ph);
      cust = db.prepare('SELECT * FROM customers WHERE phone = ?').get(ph);
    }
    customerId = cust.id;
  }

  const payType = paymentType === 'pay_now' ? 'pay_now' : 'pay_at_club';
  const { rate, isPeak } = getRate(table, start, settings);
  const amount  = calcPrice(rate, dur);
  const deposit = payType === 'pay_now' ? calcDeposit(amount, settings) : 0;

  // Grace deadline
  const graceMin = payType === 'pay_now'
    ? parseInt(settings.grace_prepaid_min, 10)
    : parseInt(settings.grace_unpaid_min, 10);
  const graceDeadline = start + graceMin * 60000;

  // ── ATOMIC OVERLAP CHECK + INSERT (IMMEDIATE lock prevents TOCTOU race) ──
  const createBooking = db.transaction(() => {
    const conflict = checkOverlap(db, Number(tableId), start, end, bufferMs, null);
    if (conflict.blocked) {
      return { error: conflict.reason };
    }

    // Generate code
    const row = db.prepare("SELECT MAX(CAST(SUBSTR(booking_code,4) AS INTEGER)) as n FROM bookings").get();
    const n   = (row && row.n) ? row.n + 1 : 1;
    const code = `BK-${String(n).padStart(4,'0')}`;

    const depStatus = payType === 'pay_now' ? 'paid' : 'pending';

    db.prepare(`
      INSERT INTO bookings
        (booking_code,customer_id,table_id,start_ts,end_ts,duration_min,status,payment_type,
         deposit_status,deposit_amount,grace_deadline,rate_at_booking,created_by_user)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      code, customerId, Number(tableId), start, end, dur,
      'confirmed', payType, depStatus, deposit, graceDeadline, rate,
      actorUserId || null
    );

    const booking = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(code);

    // Log deposit payment if pay_now
    if (payType === 'pay_now' && deposit > 0) {
      db.prepare(`
        INSERT INTO payments(bill_id,booking_id,customer_id,type,amount,mode,note)
        VALUES(?,?,?,?,?,?,?)
      `).run(null, booking.id, customerId, 'deposit', deposit, 'online', 'Online deposit at booking');
    }

    return { booking };
  });

  const result = createBooking.immediate();
  if (result.error) return res.status(409).json({ error: result.error });

  const bk = result.booking;
  res.status(201).json({
    bookingCode: bk.booking_code,
    tableId:     bk.table_id,
    tableName:   table.name,
    startTs:     bk.start_ts,
    endTs:       bk.end_ts,
    durationMin: bk.duration_min,
    status:      bk.status,
    paymentType: bk.payment_type,
    depositStatus: bk.deposit_status,
    depositAmount: bk.deposit_amount,
    graceDeadline: bk.grace_deadline,
    rateAtBooking: bk.rate_at_booking,
    totalAmount:   amount,
    isPeak,
  });
});

// ────────────────────────────────────────────────────────────
// GET /api/bookings  — list bookings (staff: all, customer: own)
// ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const { verifyToken, verifyCustomerToken } = require('../auth');

  let filterCustomerId = null;
  let isStaff = false;

  if (token) {
    const sp = verifyToken(token);
    const cp = verifyCustomerToken(token);
    if (sp)  isStaff = true;
    else if (cp) filterCustomerId = cp.customerId;
  }

  if (!isStaff && !filterCustomerId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const db = getDb();
  const { status, date, tableId, customerId } = req.query;

  let sql = `
    SELECT b.*, c.name as customer_name, c.phone as customer_phone,
           t.name as table_name, t.type as table_type
    FROM bookings b
    JOIN customers c ON b.customer_id = c.id
    JOIN tables t    ON b.table_id = t.id
    WHERE 1=1
  `;
  const params = [];

  if (!isStaff) {
    sql += ` AND b.customer_id = ?`;
    params.push(filterCustomerId);
  } else if (customerId) {
    sql += ` AND b.customer_id = ?`;
    params.push(Number(customerId));
  }

  if (status) {
    sql += ` AND b.status = ?`;
    params.push(status);
  }
  if (tableId) {
    sql += ` AND b.table_id = ?`;
    params.push(Number(tableId));
  }
  if (date) {
    // date is YYYY-MM-DD in IST — convert to UTC range
    const istMidnight = new Date(`${date}T00:00:00+05:30`).getTime();
    const istEnd      = istMidnight + 86400000;
    sql += ` AND b.start_ts >= ? AND b.start_ts < ?`;
    params.push(istMidnight, istEnd);
  }

  sql += ` ORDER BY b.start_ts ASC`;
  const rows = db.prepare(sql).all(...params);
  res.json({ bookings: rows });
});

// ────────────────────────────────────────────────────────────
// GET /api/bookings/:code  — single booking
// ────────────────────────────────────────────────────────────
router.get('/:code', (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const { verifyToken, verifyCustomerToken } = require('../auth');

  let filterCustomerId = null;
  let isStaff = false;

  if (token) {
    const sp = verifyToken(token);
    const cp = verifyCustomerToken(token);
    if (sp)  isStaff = true;
    else if (cp) filterCustomerId = cp.customerId;
  }

  if (!isStaff && !filterCustomerId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const db = getDb();
  const bk = db.prepare(`
    SELECT b.*, c.name as customer_name, c.phone as customer_phone,
           t.name as table_name, t.type as table_type
    FROM bookings b
    JOIN customers c ON b.customer_id = c.id
    JOIN tables t    ON b.table_id = t.id
    WHERE b.booking_code = ?
  `).get(req.params.code);

  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  // Customers can only see their own
  if (!isStaff && bk.customer_id !== filterCustomerId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({ booking: bk });
});

// ────────────────────────────────────────────────────────────
// DELETE /api/bookings/:code/cancel  — cancel a booking
// ────────────────────────────────────────────────────────────
router.post('/:code/cancel', (req, res) => {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const { verifyToken, verifyCustomerToken } = require('../auth');

  let filterCustomerId = null;
  let isStaff = false;
  let actorUserId = null;

  if (token) {
    const sp = verifyToken(token);
    const cp = verifyCustomerToken(token);
    if (sp)  { isStaff = true; actorUserId = sp.userId; }
    else if (cp) filterCustomerId = cp.customerId;
  }

  if (!isStaff && !filterCustomerId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const { reason } = req.body || {};
  const db = getDb();

  const bk = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(req.params.code);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  if (!isStaff && bk.customer_id !== filterCustomerId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!['confirmed', 'checked_in'].includes(bk.status)) {
    return res.status(409).json({ error: `Cannot cancel a booking with status "${bk.status}"` });
  }

  const now = serverNow();
  const minsUntilStart = (bk.start_ts - now) / 60000;
  const settings = getAllSettings(db);

  let refundAmount = 0;
  let refundNote   = '';

  if (bk.payment_type === 'pay_now' && bk.deposit_amount > 0) {
    const fullWindow = parseInt(settings.cancel_window_full, 10);
    const halfWindow = parseInt(settings.cancel_window_half, 10);

    if (minsUntilStart >= fullWindow) {
      refundAmount = bk.deposit_amount;
      refundNote   = `Full refund: cancelled ${Math.floor(minsUntilStart / 60)}h before start`;
    } else if (minsUntilStart >= halfWindow) {
      refundAmount = Math.round(bk.deposit_amount * 0.5 * 100) / 100;
      refundNote   = `50% refund: cancelled ${Math.floor(minsUntilStart / 60)}h before start`;
    } else {
      refundAmount = 0;
      refundNote   = `No refund: cancelled under ${halfWindow / 60}h before start`;
    }
  }

  const cancelTx = db.transaction(() => {
    db.prepare(`
      UPDATE bookings SET status='cancelled', cancel_reason=? WHERE id=?
    `).run(reason || 'No reason provided', bk.id);

    // Deposit refund entry
    if (bk.deposit_amount > 0) {
      const depStatus = refundAmount > 0 ? 'refunded' : 'forfeited';
      db.prepare(`UPDATE bookings SET deposit_status=? WHERE id=?`).run(depStatus, bk.id);

      if (refundAmount > 0) {
        db.prepare(`
          INSERT INTO payments(bill_id,booking_id,customer_id,type,amount,mode,note)
          VALUES(?,?,?,?,?,?,?)
        `).run(null, bk.id, bk.customer_id, 'refund', refundAmount, 'online', refundNote);
      } else if (bk.deposit_amount > 0 && refundAmount === 0 && bk.payment_type === 'pay_now') {
        db.prepare(`
          INSERT INTO payments(bill_id,booking_id,customer_id,type,amount,mode,note)
          VALUES(?,?,?,?,?,?,?)
        `).run(null, bk.id, bk.customer_id, 'forfeit', bk.deposit_amount, 'na', refundNote);
      }
    }

    // Activity log
    db.prepare(`
      INSERT INTO activity_log(user_id,customer_id,action,entity_type,entity_id,detail)
      VALUES(?,?,?,?,?,?)
    `).run(actorUserId || null, bk.customer_id, 'cancel_booking', 'booking', bk.id,
      JSON.stringify({ reason, refundAmount, refundNote }));
  });

  cancelTx();

  res.json({
    message: 'Booking cancelled',
    bookingCode: bk.booking_code,
    refundAmount,
    refundNote,
    depositStatus: refundAmount > 0 ? 'refunded' : (bk.deposit_amount > 0 && bk.payment_type === 'pay_now' ? 'forfeited' : 'na'),
  });
});

// ────────────────────────────────────────────────────────────
// POST /api/bookings/:code/reschedule  (staff only)
// ────────────────────────────────────────────────────────────
router.post('/:code/reschedule', requireStaff, (req, res) => {
  const { newStartTs, newDurationMin, reason } = req.body || {};
  if (!newStartTs || !newDurationMin) {
    return res.status(400).json({ error: 'newStartTs and newDurationMin required' });
  }

  const db = getDb();
  const bk = db.prepare('SELECT * FROM bookings WHERE booking_code = ?').get(req.params.code);
  if (!bk) return res.status(404).json({ error: 'Booking not found' });

  if (!['confirmed', 'checked_in'].includes(bk.status)) {
    return res.status(409).json({ error: 'Only confirmed or checked-in bookings can be rescheduled' });
  }

  const settings = getAllSettings(db);
  const bufferMs = parseInt(settings.booking_buffer_min, 10) * 60000;
  const minDur   = parseInt(settings.min_duration_min, 10);
  const dur      = parseInt(newDurationMin, 10);

  if (dur < minDur) return res.status(400).json({ error: `Minimum duration is ${minDur} minutes` });

  const start = Number(newStartTs);
  const end   = start + dur * 60000;

  const hoursErr = validateOperatingHours(db, start, end);
  if (hoursErr) return res.status(400).json({ error: hoursErr });

  const rescheduleTx = db.transaction(() => {
    const conflict = checkOverlap(db, bk.table_id, start, end, bufferMs, bk.id);
    if (conflict.blocked) return { error: conflict.reason };

    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(bk.table_id);
    const { rate } = getRate(table, start, settings);

    db.prepare(`
      UPDATE bookings SET start_ts=?, end_ts=?, duration_min=?, rate_at_booking=?,
        override_reason=? WHERE id=?
    `).run(start, end, dur, rate, reason || 'Rescheduled', bk.id);

    db.prepare(`
      INSERT INTO activity_log(user_id,customer_id,action,entity_type,entity_id,detail)
      VALUES(?,?,?,?,?,?)
    `).run(req.user.userId, bk.customer_id, 'reschedule_booking', 'booking', bk.id,
      JSON.stringify({ oldStart: bk.start_ts, newStart: start, reason }));

    return { ok: true };
  });

  const result = rescheduleTx.immediate();
  if (result.error) return res.status(409).json({ error: result.error });

  const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bk.id);
  res.json({ message: 'Booking rescheduled', booking: updated });
});

// ────────────────────────────────────────────────────────────
// GET /api/bookings/check-overlap  — pure overlap check endpoint
// ────────────────────────────────────────────────────────────
router.get('/check-overlap', (req, res) => {
  const { tableId, startTs, endTs, excludeBookingId } = req.query;
  if (!tableId || !startTs || !endTs) {
    return res.status(400).json({ error: 'tableId, startTs, endTs required' });
  }

  const db = getDb();
  const settings = getAllSettings(db);
  const bufferMs = parseInt(settings.booking_buffer_min, 10) * 60000;

  const result = checkOverlap(
    db, Number(tableId), Number(startTs), Number(endTs), bufferMs,
    excludeBookingId ? Number(excludeBookingId) : null
  );
  res.json(result);
});

module.exports = router;
