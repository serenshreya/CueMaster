/**
 * test.js — Phase 1 test suite for CueMaster
 *
 * Tests:
 *  1.  Staff login (owner + staff + negative cases)
 *  2.  Customer OTP flow (new + existing + wrong OTP)
 *  3.  Get tables (seed data: 6 tables, 1 in maintenance)
 *  4.  Booking price preview
 *  5.  Create a booking (customer token)
 *  6.  Overlap rejection (exact same slot)
 *  7.  Buffer rejection (slot within 15-min buffer of existing end)
 *  8.  Valid booking after buffer
 *  9.  Concurrency: two simultaneous requests → exactly one 201, one 409
 *  10. Past booking rejected
 *  11. Cancel booking (>24h → full refund on deposit)
 *  12. Reschedule: conflicting slot rejected, free slot accepted
 *  13. Role enforcement (staff cannot read owner-only settings)
 *  14. Unauthenticated requests rejected
 *
 * Run:  node test.js   (server must already be running on :3000)
 */
'use strict';

const http = require('http');

let passed = 0;
let failed = 0;

// ── Minimal HTTP helper ──
function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: 'localhost',
      port: 3000,
      path,
      headers: Object.assign({
        'Content-Type':  'application/json',
        'Content-Length': bodyStr ? Buffer.byteLength(bodyStr) : 0,
      }, headers || {}),
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(data); } catch { json = { raw: data }; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function pass(label) {
  passed++;
  console.log('  [PASS] ' + label);
}

function fail(label, detail) {
  failed++;
  console.error('  [FAIL] ' + label);
  if (detail !== null && detail !== undefined) {
    console.error('         ' + JSON.stringify(detail).slice(0, 200));
  }
}

function assert(condition, label, detail) {
  if (condition) { pass(label); } else { fail(label, detail); }
}

// ── IST-aware timestamp helpers ──
// Returns UTC ms for a given IST hour:minute on today+dayOffset
function istTs(hourIST, minuteIST, dayOffset) {
  const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const base = new Date(nowIST);
  base.setDate(base.getDate() + (dayOffset || 0));
  const dy = base.getFullYear();
  const dm = String(base.getMonth() + 1).padStart(2, '0');
  const dd = String(base.getDate()).padStart(2, '0');
  const hh = String(hourIST || 0).padStart(2, '0');
  const mm = String(minuteIST || 0).padStart(2, '0');
  return new Date(dy + '-' + dm + '-' + dd + 'T' + hh + ':' + mm + ':00+05:30').getTime();
}

// Safe booking slot: tomorrow at given IST hour (default 14:00), well within 10:00-23:00
function slotTs(daysAhead, hourIST, minuteIST) {
  return istTs(hourIST != null ? hourIST : 14, minuteIST != null ? minuteIST : 0,
               daysAhead != null ? daysAhead : 1);
}

// ── Main test runner ──
async function runTests() {
  console.log('\n============================');
  console.log(' CueMaster Phase 1 Tests');
  console.log('============================\n');

  // ── 0. Health check ──
  console.log('[0] Health check');
  {
    const r = await request('GET', '/api/health');
    assert(r.status === 200 && r.body.ok, 'Server is up', r.body);
  }

  // ── 1. Staff login ──
  console.log('\n[1] Staff login');
  let ownerToken, staffToken;
  {
    const r1 = await request('POST', '/api/auth/staff/login', { username: 'owner', password: 'owner123' });
    assert(r1.status === 200 && r1.body.token, 'Owner login succeeds', r1.body);
    ownerToken = r1.body.token;

    const r2 = await request('POST', '/api/auth/staff/login', { username: 'staff', password: 'staff123' });
    assert(r2.status === 200 && r2.body.token, 'Staff login succeeds', r2.body);
    staffToken = r2.body.token;

    const r3 = await request('POST', '/api/auth/staff/login', { username: 'owner', password: 'wrong' });
    assert(r3.status === 401, 'Wrong password rejected', r3.body);

    const r4 = await request('POST', '/api/auth/staff/login', { username: 'ghost', password: 'x' });
    assert(r4.status === 401, 'Unknown user rejected', r4.body);
  }

  if (!ownerToken || !staffToken) {
    fail('Cannot continue: staff login failed', null);
    process.exit(1);
  }

  // ── Reset demo data so every run is fully deterministic ──
  console.log('\n[Reset] Resetting demo data for a clean run...');
  {
    const r = await request('POST', '/api/admin/reset', {}, { Authorization: 'Bearer ' + ownerToken });
    if (r.status === 200) {
      // Users re-seeded after reset — re-login
      const rl1 = await request('POST', '/api/auth/staff/login', { username: 'owner', password: 'owner123' });
      ownerToken = rl1.body.token;
      const rl2 = await request('POST', '/api/auth/staff/login', { username: 'staff', password: 'staff123' });
      staffToken = rl2.body.token;
      console.log('  [OK] Reset done, tokens refreshed');
    } else {
      console.log('  [WARN] Reset returned', r.status, r.body);
    }
  }

  // ── 2. Customer OTP flow ──
  console.log('\n[2] Customer OTP');
  // Phone guaranteed not in seeded data (seeded phones start with 98765432xx)
  const TEST_PHONE = '7700000001';
  let customerToken;
  {
    const r1 = await request('POST', '/api/auth/customer/request-otp', { phone: TEST_PHONE });
    assert(r1.status === 200, 'OTP request succeeds', r1.body);

    const r2 = await request('POST', '/api/auth/customer/verify-otp', { phone: TEST_PHONE, otp: '9999' });
    assert(r2.status === 401, 'Wrong OTP rejected', r2.body);

    // First time with this phone after reset — name required
    const r3 = await request('POST', '/api/auth/customer/verify-otp', { phone: TEST_PHONE, otp: '1234' });
    assert(r3.status === 400 && r3.body.newCustomer, 'New customer needs name', r3.body);

    const r4 = await request('POST', '/api/auth/customer/verify-otp',
      { phone: TEST_PHONE, otp: '1234', name: 'Test User' });
    assert(r4.status === 200 && r4.body.token, 'New customer created + token returned', r4.body);
    customerToken = r4.body.token;

    // Same phone again — customer exists, no name needed
    const r5 = await request('POST', '/api/auth/customer/verify-otp', { phone: TEST_PHONE, otp: '1234' });
    assert(r5.status === 200 && r5.body.token, 'Existing customer login succeeds', r5.body);

    // Seeded customer
    const r6 = await request('POST', '/api/auth/customer/verify-otp', { phone: '9876543210', otp: '1234' });
    assert(r6.status === 200 && r6.body.customer && r6.body.customer.name === 'Arjun Sharma',
      'Seeded customer login', r6.body);
  }

  if (!customerToken) {
    fail('Cannot continue: customer login failed', null);
    process.exit(1);
  }

  // ── 3. Get tables ──
  console.log('\n[3] Tables');
  {
    const r = await request('GET', '/api/tables');
    assert(r.status === 200 && Array.isArray(r.body.tables), 'Tables endpoint returns array', r.body);
    assert(r.body.tables.length === 6, '6 tables in seed data', { count: r.body.tables.length });
    const maint = r.body.tables.find(function(t) { return t.effectiveStatus === 'maintenance'; });
    assert(!!maint, 'One table is in maintenance', maint);
  }

  // ── Pre-compute safe IST booking slots (tomorrow, within opening hours) ──
  // Seeded operating hours: 10:00 – 23:00 IST
  const S1     = slotTs(1, 11, 0);   // tomorrow 11:00 IST — primary slot for table 1
  const S2     = slotTs(1, 14, 0);   // tomorrow 14:00 IST — secondary slot for table 1 (after buffer)
  const SCONC  = slotTs(1, 16, 0);   // tomorrow 16:00 IST — concurrency test on table 2
  const SFAR   = slotTs(3, 11, 0);   // 3 days out 11:00 IST — cancel test on table 3
  const SRESC  = slotTs(2, 15, 0);   // 2 days out 15:00 IST — reschedule free slot

  // ── 4. Price preview ──
  console.log('\n[4] Price preview');
  {
    const r = await request('GET', '/api/bookings/price?tableId=1&startTs=' + S1 + '&durationMin=60');
    assert(r.status === 200 && r.body.amount > 0, 'Price returned with positive amount', r.body);
  }

  // ── 5. Create a booking ──
  console.log('\n[5] Create booking');
  let bookingCode;
  {
    const r = await request('POST', '/api/bookings',
      { tableId: 1, startTs: S1, durationMin: 60, paymentType: 'pay_at_club' },
      { Authorization: 'Bearer ' + customerToken });
    assert(r.status === 201 && r.body.bookingCode, 'Booking created (201)', r.body);
    bookingCode = r.body.bookingCode;
    if (bookingCode) {
      assert(bookingCode.startsWith('BK-'), 'Booking code format BK-XXXX', bookingCode);
    }
  }

  // ── 6. Overlap rejection ──
  console.log('\n[6] Overlap rejection (exact same slot, same table)');
  {
    const r = await request('POST', '/api/bookings',
      { tableId: 1, startTs: S1, durationMin: 60, paymentType: 'pay_at_club' },
      { Authorization: 'Bearer ' + customerToken });
    assert(r.status === 409, 'Exact overlap rejected with HTTP 409', { status: r.status });
    assert(r.body.error && r.body.error.length > 0, 'Error message returned', r.body);
  }

  // ── 7. Buffer rejection ──
  console.log('\n[7] Buffer rejection (start within 15-min buffer of previous booking end)');
  {
    // S1 + 60 min = booking end; buffer = 15 min → next valid start = S1 + 75 min
    // Try S1 + 65 min — inside the buffer window
    const bufferViolation = S1 + 65 * 60 * 1000;
    const r = await request('POST', '/api/bookings',
      { tableId: 1, startTs: bufferViolation, durationMin: 60, paymentType: 'pay_at_club' },
      { Authorization: 'Bearer ' + customerToken });
    assert(r.status === 409, 'Buffer violation rejected with HTTP 409', { status: r.status, err: r.body.error });
  }

  // ── 8. Valid booking after buffer ──
  console.log('\n[8] Valid booking after buffer (S2 is 3 h after S1, well clear of buffer)');
  let bookingCode2;
  {
    const r = await request('POST', '/api/bookings',
      { tableId: 1, startTs: S2, durationMin: 60, paymentType: 'pay_at_club' },
      { Authorization: 'Bearer ' + customerToken });
    assert(r.status === 201, 'Second booking on same table (after buffer) succeeds', r.body);
    bookingCode2 = r.body.bookingCode;
  }

  // ── 9. Concurrency test ──
  console.log('\n[9] Concurrency: two simultaneous conflicting requests (IMMEDIATE transaction)');
  {
    const makeBooking = function() {
      return request('POST', '/api/bookings',
        { tableId: 2, startTs: SCONC, durationMin: 60, paymentType: 'pay_at_club' },
        { Authorization: 'Bearer ' + customerToken });
    };
    const [r1, r2] = await Promise.all([makeBooking(), makeBooking()]);
    const statuses = [r1.status, r2.status].sort();
    assert(statuses[0] === 201 && statuses[1] === 409,
      'Concurrency: exactly one 201 and one 409',
      { statuses, body1: r1.body.bookingCode || r1.body.error, body2: r2.body.bookingCode || r2.body.error });
  }

  // ── 10. Past booking rejected ──
  console.log('\n[10] Past booking rejected');
  {
    const r = await request('POST', '/api/bookings',
      { tableId: 1, startTs: Date.now() - 3600000, durationMin: 60, paymentType: 'pay_at_club' },
      { Authorization: 'Bearer ' + customerToken });
    assert(r.status === 400, 'Past booking rejected (400)', r.body);
  }

  // ── 11. Cancel booking ──
  console.log('\n[11] Cancel booking — >24h ahead → full deposit refund');
  {
    const r1 = await request('POST', '/api/bookings',
      { tableId: 3, startTs: SFAR, durationMin: 60, paymentType: 'pay_now' },
      { Authorization: 'Bearer ' + customerToken });
    assert(r1.status === 201, 'Pay-now booking created for cancel test', r1.body);

    if (r1.body.bookingCode) {
      const r2 = await request('POST', '/api/bookings/' + r1.body.bookingCode + '/cancel',
        { reason: 'Test cancellation' },
        { Authorization: 'Bearer ' + customerToken });
      assert(r2.status === 200, 'Booking cancelled successfully', r2.body);
      assert(r2.body.refundAmount === r1.body.depositAmount,
        'Full refund equals deposit amount',
        { refund: r2.body.refundAmount, deposit: r1.body.depositAmount });
    } else {
      fail('Cancel test skipped — booking creation failed', r1.body);
    }
  }

  // ── 12. Reschedule with overlap check ──
  console.log('\n[12] Reschedule — overlap check + valid reschedule');
  if (bookingCode && bookingCode2) {
    // Attempt to reschedule bookingCode2 into S1 (occupied by bookingCode) → must fail
    const r1 = await request('POST', '/api/bookings/' + bookingCode2 + '/reschedule',
      { newStartTs: S1, newDurationMin: 60, reason: 'Overlap test' },
      { Authorization: 'Bearer ' + ownerToken });
    assert(r1.status === 409, 'Reschedule to conflicting slot rejected (409)', r1.body);

    // Valid reschedule to a completely free future slot on the same table
    const r2 = await request('POST', '/api/bookings/' + bookingCode2 + '/reschedule',
      { newStartTs: SRESC, newDurationMin: 60, reason: 'Moving to quieter time' },
      { Authorization: 'Bearer ' + ownerToken });
    assert(r2.status === 200, 'Reschedule to free slot succeeds (200)', r2.body);
  } else {
    fail('Reschedule tests skipped — prior booking creation failed', null);
  }

  // ── 13. Role enforcement ──
  console.log('\n[13] Role enforcement');
  {
    const r1 = await request('GET', '/api/admin/settings', null,
      { Authorization: 'Bearer ' + staffToken });
    assert(r1.status === 403, 'Staff cannot read owner settings (403)', r1.body);

    const r2 = await request('GET', '/api/admin/settings', null,
      { Authorization: 'Bearer ' + ownerToken });
    assert(r2.status === 200, 'Owner can read settings (200)', null);
  }

  // ── 14. Unauthenticated requests ──
  console.log('\n[14] Auth enforcement');
  {
    const r1 = await request('GET', '/api/bookings');
    assert(r1.status === 401, 'Unauthenticated GET /bookings rejected (401)', r1.body);

    const r2 = await request('POST', '/api/bookings',
      { tableId: 1, startTs: slotTs(5, 11, 0), durationMin: 60, paymentType: 'pay_at_club' });
    assert(r2.status === 401, 'Unauthenticated POST /bookings rejected (401)', r2.body);
  }

  // ── Summary ──
  console.log('\n============================');
  console.log(' Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('============================\n');
  if (failed > 0) process.exit(1);
}

runTests().catch(function(err) {
  console.error('\n[FATAL] Test runner crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
