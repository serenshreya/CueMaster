'use strict';

const jwt = require('jsonwebtoken');
const { getSetting } = require('./seed');

const JWT_SECRET = process.env.JWT_SECRET || 'cuemaster_secret_2024_not_for_production';
const JWT_EXPIRES = '12h';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Middleware: require staff or owner JWT
function requireStaff(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = payload;
  next();
}

// Middleware: require owner role
function requireOwner(req, res, next) {
  requireStaff(req, res, () => {
    if (req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Owner access required' });
    }
    next();
  });
}

// Customer JWT (phone-based, no password — OTP 1234)
const CUSTOMER_JWT_EXPIRES = '6h';

function signCustomerToken(payload) {
  return jwt.sign(payload, JWT_SECRET + '_cust', { expiresIn: CUSTOMER_JWT_EXPIRES });
}

function verifyCustomerToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET + '_cust');
  } catch {
    return null;
  }
}

function requireCustomer(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Customer authentication required' });
  const payload = verifyCustomerToken(token);
  if (!payload) return res.status(401).json({ error: 'Invalid or expired customer token' });
  req.customer = payload;
  next();
}

module.exports = { signToken, verifyToken, requireStaff, requireOwner, signCustomerToken, verifyCustomerToken, requireCustomer };
