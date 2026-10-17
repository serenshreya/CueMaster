'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../db');
const { serverNow } = require('../seed');

// GET /api/tables  — public, no auth required
router.get('/', (req, res) => {
  const db   = getDb();
  const now  = serverNow();
  const rows = db.prepare('SELECT * FROM tables ORDER BY type, id').all();

  // Enrich each table with next available time
  const enriched = rows.map(t => {
    // Find next booking start after now
    const nextBooking = db.prepare(`
      SELECT start_ts, end_ts FROM bookings
      WHERE table_id = ? AND status IN ('confirmed','checked_in','in_play')
        AND end_ts > ?
      ORDER BY start_ts ASC LIMIT 1
    `).get(t.id, now);

    // Find active maintenance block
    const maintBlock = db.prepare(`
      SELECT start_ts, end_ts FROM maintenance_blocks
      WHERE table_id = ? AND end_ts > ? AND start_ts <= ?
      ORDER BY start_ts ASC LIMIT 1
    `).get(t.id, now, now);

    // Effective status
    let effectiveStatus = t.status;
    if (maintBlock) effectiveStatus = 'maintenance';

    const nextAvailableTs = nextBooking ? nextBooking.end_ts : null;
    const maintEndTs      = maintBlock  ? maintBlock.end_ts  : null;

    return {
      ...t,
      effectiveStatus,
      nextAvailableTs: effectiveStatus === 'maintenance' ? maintEndTs : nextAvailableTs,
    };
  });

  res.json({ tables: enriched });
});

// GET /api/tables/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const t  = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Table not found' });
  res.json({ table: t });
});

module.exports = router;
