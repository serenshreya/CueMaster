'use strict';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Server-side time offset in ms (for demo clock)
let timeOffset = 0;
function serverNow() { return Date.now() + timeOffset; }
function getOffset() { return timeOffset; }
function setOffset(ms) { timeOffset = ms; }
function addOffset(ms) { timeOffset += ms; }

// IST display helper
function toIST(ts) {
  return new Date(ts).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function toISTDate(ts) {
  return new Date(ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
}

function toISTTime(ts) {
  return new Date(ts).toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false
  });
}

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, String(value));
}

function nextCode(prefix, table, colName) {
  const db = getDb();
  const row = db.prepare(`SELECT MAX(CAST(SUBSTR(${colName},${prefix.length+1}) AS INTEGER)) as n FROM ${table}`).get();
  const n = (row && row.n) ? row.n + 1 : 1;
  return `${prefix}${String(n).padStart(4, '0')}`;
}

function ensureStaffUsers(db) {
  const ownerHash = bcrypt.hashSync('owner123', 10);
  const staffHash = bcrypt.hashSync('staff123', 10);
  db.prepare(`
    INSERT INTO users(username, password_hash, role) VALUES('owner', ?, 'owner')
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role='owner'
  `).run(ownerHash);
  db.prepare(`
    INSERT INTO users(username, password_hash, role) VALUES('staff', ?, 'staff')
    ON CONFLICT(username) DO UPDATE SET password_hash=excluded.password_hash, role='staff'
  `).run(staffHash);
}

function seedData() {
  const db = getDb();

  // Always ensure both staff users exist with correct password hashes
  ensureStaffUsers(db);

  // Check if tables/customers already seeded
  const existing = db.prepare("SELECT COUNT(*) as c FROM tables").get();
  if (existing.c > 0) return;

  console.log('[seed] Seeding demo data...');

  // Settings
  const defaultSettings = {
    club_name: 'CueMaster Snooker & Pool Club',
    club_address: '42 MG Road, Bengaluru, Karnataka 560001',
    club_phone: '+91 98765 43210',
    opening_hour: '10:00',
    closing_hour: '23:00',
    min_duration_min: '30',
    booking_buffer_min: '15',
    peak_start: '17:00',
    peak_end: '22:00',
    peak_multiplier: '1.5',
    deposit_type: 'percent',   // 'flat' or 'percent'
    deposit_value: '50',       // 50% of booking cost
    grace_prepaid_min: '15',   // grace for paid bookings
    grace_unpaid_min: '10',    // grace for pay-at-club
    refund_policy_text: '100% refund if cancelled 24h+ before start. 50% refund if cancelled 2-24h before. No refund under 2h.',
    cancel_window_full: '1440',    // minutes for 100% refund
    cancel_window_half: '120',     // minutes for 50% refund
    currency_symbol: 'Rs.',
  };
  for (const [k, v] of Object.entries(defaultSettings)) setSetting(k, v);

  // Users guaranteed by ensureStaffUsers above

  // Tables: 4 snooker, 2 pool; table 5 in maintenance
  const tableRows = [
    { code: 'T-001', name: 'Snooker Table 1', type: 'snooker', status: 'available', hourly_rate: 400, peak_rate: 600 },
    { code: 'T-002', name: 'Snooker Table 2', type: 'snooker', status: 'available', hourly_rate: 400, peak_rate: 600 },
    { code: 'T-003', name: 'Snooker Table 3', type: 'snooker', status: 'available', hourly_rate: 350, peak_rate: 525 },
    { code: 'T-004', name: 'Snooker Table 4', type: 'snooker', status: 'available', hourly_rate: 350, peak_rate: 525 },
    { code: 'T-005', name: 'Pool Table 1',    type: 'pool',    status: 'maintenance', hourly_rate: 250, peak_rate: 375 },
    { code: 'T-006', name: 'Pool Table 2',    type: 'pool',    status: 'available', hourly_rate: 250, peak_rate: 375 },
  ];
  const insertTable = db.prepare(
    "INSERT INTO tables(table_code,name,type,status,hourly_rate,peak_rate) VALUES(?,?,?,?,?,?)"
  );
  for (const t of tableRows) {
    insertTable.run(t.code, t.name, t.type, t.status, t.hourly_rate, t.peak_rate);
  }

  // Maintenance block for Pool Table 1
  const maintTable = db.prepare("SELECT id FROM tables WHERE name = ?").get('Pool Table 1');
  const ownerUser  = db.prepare("SELECT id FROM users WHERE username = ?").get('owner');
  const maintTableId = maintTable ? maintTable.id : 5;
  const ownerId      = ownerUser ? ownerUser.id : 1;

  const maintStart = serverNow() - 2 * 60 * 60 * 1000;
  const maintEnd   = serverNow() + 4 * 60 * 60 * 1000;
  db.prepare("INSERT INTO maintenance_blocks(table_id,start_ts,end_ts,reason,created_by) VALUES(?,?,?,?,?)")
    .run(maintTableId, maintStart, maintEnd, 'Baize replacement', ownerId);

  // 8 Customers
  const customerRows = [
    { code: 'C-0001', name: 'Arjun Sharma',   phone: '9876543210' },
    { code: 'C-0002', name: 'Priya Patel',    phone: '9876543211' },
    { code: 'C-0003', name: 'Rahul Mehta',    phone: '9876543212' },
    { code: 'C-0004', name: 'Sneha Reddy',    phone: '9876543213' },
    { code: 'C-0005', name: 'Vikram Singh',   phone: '9876543214' },
    { code: 'C-0006', name: 'Ananya Iyer',    phone: '9876543215' },
    { code: 'C-0007', name: 'Rohan Gupta',    phone: '9876543216' },
    { code: 'C-0008', name: 'Meera Nair',     phone: '9876543217' },
  ];
  const insertCust = db.prepare(
    "INSERT INTO customers(customer_code,name,phone) VALUES(?,?,?)"
  );
  for (const c of customerRows) insertCust.run(c.code, c.name, c.phone);

  // Past bookings, sessions, bills, payments for historical data
  const insertBooking = db.prepare(`
    INSERT INTO bookings
    (booking_code,customer_id,table_id,start_ts,end_ts,duration_min,status,payment_type,
     deposit_status,deposit_amount,rate_at_booking,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions
    (booking_id,customer_id,table_id,walk_in,checkin_ts,start_ts,end_ts,paused_ms,status,rate_at_session,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertBill = db.prepare(`
    INSERT INTO bills
    (receipt_code,session_id,booking_id,customer_id,table_id,actual_min,base_amount,
     addons_amount,discount,deposit_credit,total_amount,due_amount,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertPayment = db.prepare(`
    INSERT INTO payments(bill_id,booking_id,customer_id,type,amount,mode,note,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `);

  // Helper: past booking + session + bill
  function seedPastVisit(opts) {
    const {
      bCode, custId, tableId, startTs, endTs, durMin,
      payType, depStatus, depAmt, rate, bCreatedAt,
      sessId, rcCode, actualMin, baseAmt, addons, disc, depCredit, total, due,
      billStatus, billCreatedAt, pmtMode
    } = opts;

    insertBooking.run(
      bCode, custId, tableId, startTs, endTs, durMin, 'completed', payType,
      depStatus, depAmt, rate, bCreatedAt
    );
    const bookingRow = db.prepare("SELECT id FROM bookings WHERE booking_code=?").get(bCode);

    insertSession.run(
      bookingRow.id, custId, tableId, 0,
      startTs, startTs, endTs, 0, 'completed', rate, bCreatedAt
    );
    const sessionRow = db.prepare("SELECT id FROM sessions WHERE booking_id=?").get(bookingRow.id);

    insertBill.run(
      rcCode, sessionRow.id, bookingRow.id, custId, tableId,
      actualMin, baseAmt, addons, disc, depCredit, total, due,
      billStatus, billCreatedAt
    );
    const billRow = db.prepare("SELECT id FROM bills WHERE receipt_code=?").get(rcCode);

    if (depAmt > 0) {
      insertPayment.run(billRow.id, bookingRow.id, custId, 'deposit', depAmt, 'online', 'Deposit paid online', bCreatedAt);
    }
    if (due <= 0 || billStatus === 'paid') {
      insertPayment.run(billRow.id, bookingRow.id, custId, 'session_payment', total - depAmt, pmtMode, 'Session payment', billCreatedAt);
    }
  }

  const now = serverNow();
  const DAY = 86400000;

  // Customer 1 – 3 visits
  seedPastVisit({ bCode:'BK-0001', custId:1, tableId:1, startTs: now-7*DAY, endTs: now-7*DAY+90*60000,
    durMin:90, payType:'pay_now', depStatus:'paid', depAmt:300, rate:400, bCreatedAt: now-7*DAY-3600000,
    rcCode:'RC-0001', actualMin:90, baseAmt:600, addons:0, disc:0, depCredit:300, total:600, due:300, billStatus:'paid', billCreatedAt: now-7*DAY+90*60000, pmtMode:'cash' });

  seedPastVisit({ bCode:'BK-0002', custId:1, tableId:2, startTs: now-3*DAY, endTs: now-3*DAY+60*60000,
    durMin:60, payType:'pay_at_club', depStatus:'na', depAmt:0, rate:400, bCreatedAt: now-3*DAY-3600000,
    rcCode:'RC-0002', actualMin:65, baseAmt:433, addons:100, disc:0, depCredit:0, total:533, due:533, billStatus:'paid', billCreatedAt: now-3*DAY+65*60000, pmtMode:'upi' });

  seedPastVisit({ bCode:'BK-0003', custId:1, tableId:1, startTs: now-DAY, endTs: now-DAY+120*60000,
    durMin:120, payType:'pay_now', depStatus:'paid', depAmt:600, rate:600, bCreatedAt: now-DAY-3600000,
    rcCode:'RC-0003', actualMin:120, baseAmt:1200, addons:200, disc:100, depCredit:600, total:1300, due:700, billStatus:'paid', billCreatedAt: now-DAY+120*60000, pmtMode:'upi' });

  // Customer 2 – 2 visits
  seedPastVisit({ bCode:'BK-0004', custId:2, tableId:6, startTs: now-5*DAY, endTs: now-5*DAY+60*60000,
    durMin:60, payType:'pay_at_club', depStatus:'na', depAmt:0, rate:250, bCreatedAt: now-5*DAY-1800000,
    rcCode:'RC-0004', actualMin:60, baseAmt:250, addons:0, disc:0, depCredit:0, total:250, due:250, billStatus:'paid', billCreatedAt: now-5*DAY+60*60000, pmtMode:'cash' });

  seedPastVisit({ bCode:'BK-0005', custId:2, tableId:6, startTs: now-2*DAY, endTs: now-2*DAY+90*60000,
    durMin:90, payType:'pay_now', depStatus:'paid', depAmt:188, rate:250, bCreatedAt: now-2*DAY-3600000,
    rcCode:'RC-0005', actualMin:90, baseAmt:375, addons:50, disc:0, depCredit:188, total:425, due:237, billStatus:'paid', billCreatedAt: now-2*DAY+90*60000, pmtMode:'cash' });

  // Customer 3 – 1 visit
  seedPastVisit({ bCode:'BK-0006', custId:3, tableId:3, startTs: now-4*DAY, endTs: now-4*DAY+60*60000,
    durMin:60, payType:'pay_at_club', depStatus:'na', depAmt:0, rate:350, bCreatedAt: now-4*DAY-900000,
    rcCode:'RC-0006', actualMin:60, baseAmt:350, addons:0, disc:0, depCredit:0, total:350, due:350, billStatus:'paid', billCreatedAt: now-4*DAY+60*60000, pmtMode:'cash' });

  // Customer 4 – walk-in
  seedPastVisit({ bCode:'BK-0007', custId:4, tableId:4, startTs: now-6*DAY, endTs: now-6*DAY+90*60000,
    durMin:90, payType:'pay_at_club', depStatus:'na', depAmt:0, rate:350, bCreatedAt: now-6*DAY,
    rcCode:'RC-0007', actualMin:90, baseAmt:525, addons:150, disc:50, depCredit:0, total:625, due:625, billStatus:'paid', billCreatedAt: now-6*DAY+90*60000, pmtMode:'upi' });

  // Customer 5 – cancelled booking (no session/bill needed, just a booking row)
  const cancelledStart = now - 2*DAY + 3*3600000;
  insertBooking.run(
    'BK-0008', 5, 1, cancelledStart, cancelledStart+60*60000, 60,
    'cancelled', 'pay_now', 'refunded', 300, 600, now-2*DAY
  );
  const bk8 = db.prepare("SELECT id FROM bookings WHERE booking_code='BK-0008'").get();
  db.prepare("UPDATE bookings SET cancel_reason='Personal reasons' WHERE id=?").run(bk8.id);
  insertPayment.run(null, bk8.id, 5, 'deposit', 300, 'online', 'Deposit paid online', now-2*DAY);
  insertPayment.run(null, bk8.id, 5, 'refund', 300, 'online', 'Full refund: cancelled 24h+ before', now-2*DAY+3600000);

  // Seed sample kitchen orders (matching Image 8 KOT)
  const existingOrders = db.prepare("SELECT COUNT(*) as c FROM orders").get();
  if (existingOrders.c === 0) {
    const insertOrder = db.prepare("INSERT INTO orders(order_code, table_id, items_summary, total_amount, status, created_at) VALUES(?,?,?,?,?,?)");
    insertOrder.run('K1023', 3, '2x Margherita Pizza + 1x Coke', 450, 'preparing', now - 11*60000);
    insertOrder.run('K1022', 5, '1x Truffle Fries + 2x Mocktails', 580, 'ready', now - 14*60000);
    insertOrder.run('K1021', 1, '1x Nachos + 1x Cold Coffee', 380, 'on_hold', now - 17*60000);
    insertOrder.run('K1020', 6, '2x Pasta + 1x Garlic Bread', 520, 'preparing', now - 22*60000);
    insertOrder.run('K1019', 4, '1x Brownie + 2x Lemonade', 340, 'ready', now - 26*60000);
  }

  console.log('[seed] Demo data seeded successfully.');
}

function resetDemoData() {
  const db = getDb();
  // Delete in reverse FK order
  const tables = [
    'orders','activity_log','bill_addons','payments','bills','sessions',
    'bookings','maintenance_blocks','customers','tables','users','settings'
  ];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  // Reset autoincrement sequences
  db.prepare("DELETE FROM sqlite_sequence").run();
  // Re-seed
  timeOffset = 0;
  seedData();
  ensureStaffUsers(db);
}

module.exports = { serverNow, getOffset, setOffset, addOffset, toIST, toISTDate, toISTTime, getSetting, setSetting, nextCode, seedData, resetDemoData };
