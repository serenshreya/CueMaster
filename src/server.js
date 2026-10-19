'use strict';

const express = require('express');
const path    = require('path');
const { initSchema } = require('./db');
const { seedData, serverNow } = require('./seed');

// Routes
const authRoutes     = require('./routes/auth');
const bookingRoutes  = require('./routes/bookings');
const tableRoutes    = require('./routes/tables');
const adminRoutes    = require('./routes/admin');
const sessionRoutes  = require('./routes/sessions');
const billingRoutes  = require('./routes/billing');
const customerRoutes = require('./routes/customers');
const orderRoutes    = require('./routes/orders');
const khatabookRoutes= require('./routes/khatabook');
const contriRoutes   = require('./routes/contri');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Initialize DB ──
initSchema();
seedData();

// ── API Routes ──
app.use('/api/auth',      authRoutes);
app.use('/api/bookings',  bookingRoutes);
app.use('/api/tables',    tableRoutes);
app.use('/api/admin',     adminRoutes);
app.use('/api/sessions',  sessionRoutes);
app.use('/api/bills',     billingRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/orders',    orderRoutes);
app.use('/api/kot',       orderRoutes);
app.use('/api/khatabook', khatabookRoutes);
app.use('/api/contri',    contriRoutes);

// ── Clean Page Routes ──
app.get('/book', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'booking.html')));
app.get('/booking', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'booking.html')));
app.get('/contri-hub', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'contri-hub.html')));
app.get('/contri', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'contri-hub.html')));
app.get('/table', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'table.html')));
app.get('/table/:id', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'table.html')));
app.get('/scan-to-get', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'scan-to-get.html')));
app.get('/scan', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'scan-to-get.html')));
app.get('/junior-zone', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'junior-zone.html')));
app.get('/junior', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'junior-zone.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'staff.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'staff.html')));
app.get('/receipt', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'receipt.html')));

// ── Health check ──
app.get('/api/health', (req, res) => {
  res.json({ ok: true, serverTime: serverNow(), version: '1.0.0-phase3' });
});

// ── Analytics (simple stats for staff dashboard) ──
app.get('/api/analytics', (req, res) => {
  const { getDb } = require('./db');
  const db  = getDb();
  const now = serverNow();
  const todayStart = new Date(new Date(now).toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata' }) + ' 00:00:00').getTime();

  const todayRevenue   = db.prepare("SELECT COALESCE(SUM(total_amount),0) as v FROM bills WHERE created_at>=?").get(todayStart - 5.5*3600000).v;
  const activeSessions = db.prepare("SELECT COUNT(*) as v FROM sessions WHERE status IN ('active','paused','pending')").get().v;
  const todayBookings  = db.prepare("SELECT COUNT(*) as v FROM bookings WHERE start_ts>=? AND start_ts<?").get(todayStart - 5.5*3600000, todayStart - 5.5*3600000 + 86400000).v;
  const outstandingDues= db.prepare("SELECT COALESCE(SUM(due_amount),0) as v FROM bills WHERE status!='paid'").get().v;

  res.json({ todayRevenue, activeSessions, todayBookings, outstandingDues, serverNow: now });
});

// ── No-show auto-marking job (every 5 seconds) ──
function startNoShowJob() {
  const { getDb } = require('./db');
  setInterval(() => {
    try {
      const db  = getDb();
      const now = serverNow();
      const expired = db.prepare(`
        SELECT * FROM bookings
        WHERE status='confirmed' AND grace_deadline IS NOT NULL AND grace_deadline < ?
      `).all(now);

      for (const bk of expired) {
        db.transaction(() => {
          // NEVER touch checked_in or in_play
          const current = db.prepare('SELECT status FROM bookings WHERE id=?').get(bk.id);
          if (!current || current.status !== 'confirmed') return;

          db.prepare("UPDATE bookings SET status='no_show',no_show_reason=? WHERE id=?")
            .run('Grace period expired — auto-marked by system', bk.id);
          db.prepare("UPDATE customers SET no_show_count=no_show_count+1 WHERE id=?")
            .run(bk.customer_id);

          // Deposit outcome
          if (bk.payment_type === 'pay_now' && bk.deposit_amount > 0) {
            db.prepare("UPDATE bookings SET deposit_status='forfeited' WHERE id=?").run(bk.id);
            db.prepare("INSERT INTO payments(booking_id,customer_id,type,amount,mode,note) VALUES(?,?,?,?,?,?)")
              .run(bk.id, bk.customer_id, 'forfeit', bk.deposit_amount, 'na', 'Auto-forfeit: no-show');
          }

          // Release table if no other active session
          const otherSession = db.prepare("SELECT id FROM sessions WHERE table_id=? AND status IN ('pending','active','paused')").get(bk.table_id);
          if (!otherSession) {
            db.prepare("UPDATE tables SET status='available' WHERE id=?").run(bk.table_id);
          }

          db.prepare("INSERT INTO activity_log(customer_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)")
            .run(bk.customer_id, 'auto_no_show', 'booking', bk.id,
              JSON.stringify({ bookingCode: bk.booking_code, depositForfeited: bk.deposit_amount || 0 }));

          console.log(`[no-show] ${bk.booking_code} marked no_show (deposit: ${bk.deposit_amount > 0 ? 'forfeited' : 'na'})`);
        })();
      }
    } catch (err) {
      console.error('[no-show job]', err.message);
    }
  }, 5000);
}

startNoShowJob();

// ── Catch-all: serve index.html ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\nCueMaster running at http://localhost:${PORT}`);
  console.log(`  Customer site:  http://localhost:${PORT}/`);
  console.log(`  Staff dashboard: http://localhost:${PORT}/staff.html`);
  console.log(`  Staff login:  owner / owner123  |  staff / staff123`);
  console.log(`  Customer OTP: 1234 (any 10-digit phone)\n`);
});

module.exports = app;
