'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { serverNow } = require('../seed');

// GET /api/orders — list kitchen order tickets
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  res.json({ orders: rows });
});

// POST /api/orders — create new order ticket (e.g. from Table QR)
router.post('/', (req, res) => {
  const { tableId, itemsSummary, totalAmount } = req.body || {};
  if (!tableId || !itemsSummary) {
    return res.status(400).json({ error: 'tableId and itemsSummary required' });
  }
  const db = getDb();
  const now = serverNow();
  const codeRow = db.prepare("SELECT MAX(id) as maxId FROM orders").get();
  const nextId = (codeRow && codeRow.maxId ? codeRow.maxId : 1018) + 1;
  const orderCode = `K${nextId}`;

  db.prepare(`
    INSERT INTO orders(order_code, table_id, items_summary, total_amount, status, created_at)
    VALUES(?,?,?,?,?,?)
  `).run(orderCode, Number(tableId), itemsSummary, Number(totalAmount || 0), 'preparing', now);

  const newOrder = db.prepare("SELECT * FROM orders WHERE order_code=?").get(orderCode);
  res.status(201).json({ message: 'Order created', order: newOrder });
});

// POST /api/orders/:id/status — update order status (preparing, ready, on_hold, completed)
router.post('/:id/status', (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });
  const db = getDb();
  db.prepare("UPDATE orders SET status=? WHERE id=?").run(status, Number(req.params.id));
  res.json({ ok: true, id: req.params.id, status });
});

module.exports = router;
