'use strict';

const http = require('http');

let passed = 0;
let failed = 0;

function request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      hostname: 'localhost',
      port: 3000,
      path,
      headers: Object.assign({
        'Content-Type': 'application/json',
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

function assert(condition, label, detail) {
  if (condition) {
    passed++;
    console.log('  [PASS] ' + label);
  } else {
    failed++;
    console.error('  [FAIL] ' + label);
    if (detail !== null && detail !== undefined) {
      console.error('         ' + JSON.stringify(detail).slice(0, 200));
    }
  }
}

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

async function run() {
  console.log('\n========================================');
  console.log(' CueMaster Phase 2 & 3 Automated Tests');
  console.log('========================================\n');

  // 1. Staff login & reset
  console.log('[1] Login & Reset');
  const loginRes = await request('POST', '/api/auth/staff/login', { username: 'owner', password: 'owner123' });
  let token = loginRes.body.token;
  assert(loginRes.status === 200 && token, 'Owner login successful');

  const resetRes = await request('POST', '/api/admin/reset', {}, { Authorization: 'Bearer ' + token });
  assert(resetRes.status === 200, 'Demo data reset successful');

  const relogin = await request('POST', '/api/auth/staff/login', { username: 'owner', password: 'owner123' });
  token = relogin.body.token;

  // 2. Customer OTP login
  console.log('\n[2] Customer Login');
  const custLogin = await request('POST', '/api/auth/customer/verify-otp', { phone: '9876543210', otp: '1234' });
  const custToken = custLogin.body.token;
  assert(custLogin.status === 200 && custToken, 'Customer OTP login successful');

  // 3. Create a booking for session test
  console.log('\n[3] Create Booking for Session Flow');
  const slot1 = istTs(11, 0, 1);
  const bkRes = await request('POST', '/api/bookings', {
    tableId: 1,
    startTs: slot1,
    durationMin: 60,
    paymentType: 'pay_now'
  }, { Authorization: 'Bearer ' + custToken });
  assert(bkRes.status === 201 && bkRes.body.bookingCode, 'Prepaid booking created', bkRes.body);
  const bookingCode = bkRes.body.bookingCode;
  const depositAmount = bkRes.body.depositAmount;

  // 4. Session Check-in
  console.log('\n[4] Session Lifecycle: Checkin, Start, Pause, Resume, Extend, End');
  const checkinRes = await request('POST', '/api/sessions/checkin', { bookingCode }, { Authorization: 'Bearer ' + token });
  assert(checkinRes.status === 200 && checkinRes.body.session, 'Checkin successful', checkinRes.body);
  const sessionId = checkinRes.body.session.id;

  // Start session
  const startRes = await request('POST', `/api/sessions/${sessionId}/start`, {}, { Authorization: 'Bearer ' + token });
  assert(startRes.status === 200, 'Session started', startRes.body);

  // Pause session
  const pauseRes = await request('POST', `/api/sessions/${sessionId}/pause`, {}, { Authorization: 'Bearer ' + token });
  assert(pauseRes.status === 200, 'Session paused', pauseRes.body);

  // Resume session
  const resumeRes = await request('POST', `/api/sessions/${sessionId}/resume`, {}, { Authorization: 'Bearer ' + token });
  assert(resumeRes.status === 200, 'Session resumed', resumeRes.body);

  // Create a consecutive booking to test extension conflict:
  // slot1 + 60min = 12:00. Buffer is 15min. Next booking starts at 12:15.
  const slotNext = slot1 + 75 * 60000;
  const nextBkRes = await request('POST', '/api/bookings', {
    tableId: 1,
    startTs: slotNext,
    durationMin: 60,
    paymentType: 'pay_at_club'
  }, { Authorization: 'Bearer ' + custToken });
  assert(nextBkRes.status === 201, 'Subsequent booking created to test extension guard');

  // Extend by 30 min (would end at 12:30, violating the 12:15 booking)
  const extConflict = await request('POST', `/api/sessions/${sessionId}/extend`, { extraMinutes: 30 }, { Authorization: 'Bearer ' + token });
  assert(extConflict.status === 409, 'Extension correctly rejected when blocked by next booking', extConflict.body);

  // End session
  const endRes = await request('POST', `/api/sessions/${sessionId}/end`, {}, { Authorization: 'Bearer ' + token });
  assert(endRes.status === 200 && endRes.body.actualMin >= 1, 'Session ended successfully', endRes.body);

  // 5. Walk-in session test
  console.log('\n[5] Walk-in Session');
  const walkinRes = await request('POST', '/api/sessions/walkin', {
    tableId: 2,
    phone: '9876543211',
    name: 'Walkin Player'
  }, { Authorization: 'Bearer ' + token });
  assert(walkinRes.status === 201 && walkinRes.body.session, 'Walk-in session created', walkinRes.body);
  const walkinSessId = walkinRes.body.session.id;

  const walkinStart = await request('POST', `/api/sessions/${walkinSessId}/start`, {}, { Authorization: 'Bearer ' + token });
  assert(walkinStart.status === 200, 'Walk-in session started');

  const walkinEnd = await request('POST', `/api/sessions/${walkinSessId}/end`, {}, { Authorization: 'Bearer ' + token });
  assert(walkinEnd.status === 200, 'Walk-in session ended');

  // 6. Billing & Payments
  console.log('\n[6] Billing & Payments');
  const billRes = await request('POST', '/api/bills', {
    sessionId: sessionId,
    addons: [
      { name: 'Red Bull x2', amount: 300 },
      { name: 'Snacks & Beverages', amount: 200 }
    ],
    discount: 50
  }, { Authorization: 'Bearer ' + token });
  assert(billRes.status === 201 && billRes.body.bill, 'Bill generated with addons and discount', billRes.body);
  const bill = billRes.body.bill;
  const receiptCode = billRes.body.receiptCode;

  // Check deposit credit was applied
  assert(bill.deposit_credit === depositAmount, 'Prepaid deposit credited on bill', { credit: bill.deposit_credit, deposit: depositAmount });
  assert(bill.due_amount > 100, 'Due amount is positive and exceeds 100', { due: bill.due_amount });

  // Partial Payment (Cash)
  const partPayRes = await request('POST', `/api/bills/${bill.id}/pay`, {
    amount: 100,
    mode: 'cash',
    note: 'Initial cash payment'
  }, { Authorization: 'Bearer ' + token });
  assert(partPayRes.status === 200 && partPayRes.body.bill.status === 'partial', 'Partial payment recorded (status: partial)', partPayRes.body);

  // Remaining payment (UPI)
  const remDue = partPayRes.body.bill.due_amount;
  const fullPayRes = await request('POST', `/api/bills/${bill.id}/pay`, {
    amount: remDue,
    mode: 'upi',
    note: 'UPI balance payment'
  }, { Authorization: 'Bearer ' + token });
  assert(fullPayRes.status === 200 && fullPayRes.body.bill.status === 'paid', 'Full balance paid via UPI (status: paid)', fullPayRes.body);

  // 7. Printable Receipt Endpoint
  console.log('\n[7] Receipt Endpoint');
  const receiptRes = await request('GET', `/api/bills/receipt/${receiptCode}`, null, { Authorization: 'Bearer ' + token });
  assert(receiptRes.status === 200 && receiptRes.body.bill && receiptRes.body.payments.length >= 2, 'Receipt JSON data complete with addons and payments', receiptRes.body.bill);

  // 8. Demo Clock & No-Show Job
  console.log('\n[8] Demo Clock & Auto No-Show Job');
  // Create an unpaid booking on table 3 tomorrow at 11:00 AM IST (within operating hours)
  const noShowSlot = istTs(11, 0, 1);
  const nearBkRes = await request('POST', '/api/bookings', {
    tableId: 3,
    startTs: noShowSlot,
    durationMin: 60,
    paymentType: 'pay_at_club'
  }, { Authorization: 'Bearer ' + custToken });
  assert(nearBkRes.status === 201 && nearBkRes.body.bookingCode, 'Created booking for no-show test', nearBkRes.body);
  const nearBkCode = nearBkRes.body.bookingCode;

  // Fast forward clock past grace period (grace deadline is startTs + 10 min, so jump to startTs + 20 min)
  const nowRes = await request('GET', '/api/admin/clock', null, { Authorization: 'Bearer ' + token });
  const serverNow = nowRes.body.serverNow;
  const targetTs = noShowSlot + 20 * 60000;
  const diffMinutes = Math.ceil((targetTs - serverNow) / 60000);
  console.log(`  Advancing demo clock by ${diffMinutes} minutes to past grace deadline...`);
  await request('POST', '/api/admin/clock/forward', { minutes: diffMinutes }, { Authorization: 'Bearer ' + token });

  // Wait 6 seconds for no-show interval job to process
  console.log('  Waiting 6s for background no-show job to fire...');
  await new Promise(r => setTimeout(r, 6500));

  const checkBk = await request('GET', `/api/bookings/${nearBkCode}`, null, { Authorization: 'Bearer ' + token });
  assert(checkBk.status === 200 && checkBk.body.booking && checkBk.body.booking.status === 'no_show', 'Booking auto-marked as no_show by background job', checkBk.body.booking);

  // Reset clock back
  await request('POST', '/api/admin/clock/reset', {}, { Authorization: 'Bearer ' + token });

  // 9. Customer History & Self-Service
  console.log('\n[9] Customer History & Ledger');
  const meHistory = await request('GET', '/api/customers/me/history', null, { Authorization: 'Bearer ' + custToken });
  assert(meHistory.status === 200 && Array.isArray(meHistory.body.bookings) && Array.isArray(meHistory.body.bills), 'Customer self-service history returned', meHistory.body.customer);

  const customerId = checkBk.body.booking ? checkBk.body.booking.customer_id : 1;
  const staffCustHistory = await request('GET', `/api/customers/${customerId}/history`, null, { Authorization: 'Bearer ' + token });
  assert(staffCustHistory.status === 200 && staffCustHistory.body.summary && staffCustHistory.body.summary.noShowCount >= 1, 'Staff customer ledger contains updated noShowCount', staffCustHistory.body.summary);

  // Summary
  console.log('\n========================================');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
