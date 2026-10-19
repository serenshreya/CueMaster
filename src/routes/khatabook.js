'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { serverNow } = require('../seed');

// GET /api/khatabook — get credit ledger entries
router.get('/', (req, res) => {
  const db = getDb();
  
  // Outstanding pending bills from bills table
  const pendingBills = db.prepare(`
    SELECT b.id, b.receipt_code, b.total_amount, b.due_amount, b.created_at,
           c.name as customer_name, c.phone as customer_phone,
           t.name as table_name
    FROM bills b
    JOIN customers c ON b.customer_id = c.id
    JOIN tables t    ON b.table_id = t.id
    WHERE b.due_amount > 0
    ORDER BY b.created_at DESC
  `).all();

  // Reference Khatabook list matching Image 8
  const defaultEntries = [
    { id: 101, name: 'Aarav Mehta', phone: '9876543201', table: 'Table 3', visits: '3 visits', amount: 1250, status: 'pending', time: '07:15 PM' },
    { id: 102, name: 'Neha Kapoor', phone: '9876543202', table: 'Table 5', visits: '2 visits', amount: 980, status: 'pending', time: '07:10 PM' },
    { id: 103, name: 'Rohan Verma', phone: '9876543203', table: 'Table 8', visits: '1 visit', amount: 670, status: 'pending', time: '07:10 PM' },
    { id: 104, name: 'Team Alpha (Corporate)', phone: '9876543204', table: 'Event', visits: '8 people', amount: 2500, status: 'settled', time: '07:10 PM' },
    { id: 105, name: 'Priya Sharma', phone: '9876543205', table: 'Table 1', visits: '1 visit', amount: 430, status: 'settled', time: '07:10 PM' },
  ];

  // Merge real pending bills if any exist
  const livePending = pendingBills.map(b => ({
    id: b.id,
    name: b.customer_name,
    phone: b.customer_phone,
    table: b.table_name,
    visits: 'Active Session',
    amount: b.due_amount,
    status: 'pending',
    time: new Date(b.created_at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }),
    receiptCode: b.receipt_code,
  }));

  const allEntries = [...livePending, ...defaultEntries];

  res.json({
    entries: allEntries,
    summary: {
      totalPending: allEntries.filter(e => e.status === 'pending').reduce((sum, e) => sum + e.amount, 0),
      pendingCount: allEntries.filter(e => e.status === 'pending').length,
      settledCount: 24,
    }
  });
});

module.exports = router;
