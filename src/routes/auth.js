'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const router  = express.Router();

const { getDb }   = require('../db');
const { signToken, signCustomerToken } = require('../auth');

// POST /api/auth/staff/login
router.post('/staff/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const db   = getDb();
  const u    = String(username).trim();
  const p    = String(password);
  const user = db.prepare('SELECT * FROM users WHERE LOWER(username) = LOWER(?)').get(u);

  if (!user) return res.status(401).json({ error: 'Invalid username or password' });

  const ok = bcrypt.compareSync(p, user.password_hash) || bcrypt.compareSync(p.trim(), user.password_hash);
  if (!ok)  return res.status(401).json({ error: 'Invalid username or password' });

  const token = signToken({ userId: user.id, username: user.username, role: user.role });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

// POST /api/auth/customer/request-otp
// In demo mode OTP is always 1234; we just check phone exists or create customer.
router.post('/customer/request-otp', (req, res) => {
  const { phone } = req.body || {};
  if (!phone || !/^\d{10}$/.test(String(phone).trim())) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }
  // Don't reveal whether phone exists
  res.json({ message: 'OTP sent to your phone (demo OTP: 1234)' });
});

// POST /api/auth/customer/verify-otp
router.post('/customer/verify-otp', (req, res) => {
  const { phone, otp, name } = req.body || {};
  const ph = String(phone || '').trim();

  if (!ph || !/^\d{10}$/.test(ph)) {
    return res.status(400).json({ error: 'Valid 10-digit phone number required' });
  }
  if (String(otp) !== '1234') {
    return res.status(401).json({ error: 'Invalid OTP' });
  }

  const db = getDb();
  let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(ph);

  if (!customer) {
    // New customer — name required
    const custName = String(name || '').trim();
    if (!custName) {
      return res.status(400).json({ error: 'Name is required for new customers', newCustomer: true });
    }
    // Generate code
    const row = db.prepare("SELECT MAX(CAST(SUBSTR(customer_code,3) AS INTEGER)) as n FROM customers").get();
    const n   = (row && row.n) ? row.n + 1 : 1;
    const code = `C-${String(n).padStart(4,'0')}`;
    db.prepare("INSERT INTO customers(customer_code,name,phone) VALUES(?,?,?)").run(code, custName, ph);
    customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(ph);
  }

  const token = signCustomerToken({
    customerId: customer.id,
    phone: customer.phone,
    name: customer.name,
    customerCode: customer.customer_code,
  });

  res.json({ token, customer: { id: customer.id, customerCode: customer.customer_code, name: customer.name, phone: customer.phone } });
});

module.exports = router;
