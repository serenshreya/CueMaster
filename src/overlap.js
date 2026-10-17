'use strict';

/**
 * Core overlap checker (used by booking creation, reschedule, and extension).
 *
 * Returns { blocked: true, reason: '...' } if the requested slot conflicts,
 * or { blocked: false } if it's free.
 *
 * @param {object} db         - better-sqlite3 database handle
 * @param {number} tableId    - table to check
 * @param {number} startTs    - proposed slot start (ms epoch)
 * @param {number} endTs      - proposed slot end (ms epoch)
 * @param {number} bufferMs   - booking buffer in ms
 * @param {number|null} excludeBookingId - booking to ignore (for reschedule)
 */
function checkOverlap(db, tableId, startTs, endTs, bufferMs, excludeBookingId = null) {
  // ── 1. Active bookings (confirmed, checked_in, in_play) ──
  // Two intervals [existStart, existEnd] and [newStart, newEnd] overlap (with buffer) when:
  //   existStart < newEnd + buffer  AND  existEnd > newStart - buffer
  const bookingParams = [
    tableId,
    endTs   + bufferMs,  // existing.start_ts must be < new.end + buffer
    startTs - bufferMs,  // existing.end_ts must be > new.start - buffer
  ];

  let bookingSql = `
    SELECT id, booking_code, start_ts, end_ts, status
    FROM   bookings
    WHERE  table_id = ?
      AND  status IN ('confirmed','checked_in','in_play')
      AND  start_ts < ?
      AND  end_ts   > ?
  `;
  if (excludeBookingId) {
    bookingSql += ` AND id != ${Number(excludeBookingId)}`;
  }

  const conflictingBooking = db.prepare(bookingSql).get(...bookingParams);
  if (conflictingBooking) {
    return {
      blocked: true,
      reason: `Blocked by booking ${conflictingBooking.booking_code} (${conflictingBooking.status})`,
      conflictType: 'booking',
      conflictId: conflictingBooking.id,
      conflictStart: conflictingBooking.start_ts,
      conflictEnd: conflictingBooking.end_ts,
    };
  }

  // ── 2. Active sessions (active or paused) without a linked booking ──
  //    These represent walk-ins occupying the table right now.
  const sessionConflict = db.prepare(`
    SELECT id, start_ts, end_ts
    FROM   sessions
    WHERE  table_id = ?
      AND  walk_in  = 1
      AND  status   IN ('active','paused')
      AND  (end_ts IS NULL OR (start_ts < ? AND (end_ts IS NULL OR end_ts > ?)))
  `).get(tableId, endTs + bufferMs, startTs - bufferMs);

  if (sessionConflict) {
    return {
      blocked: true,
      reason: `Table is currently in use by an active walk-in session`,
      conflictType: 'session',
      conflictId: sessionConflict.id,
    };
  }

  // ── 3. Maintenance blocks ──
  const maintConflict = db.prepare(`
    SELECT id, start_ts, end_ts, reason
    FROM   maintenance_blocks
    WHERE  table_id = ?
      AND  start_ts < ?
      AND  end_ts   > ?
  `).get(tableId, endTs, startTs);

  if (maintConflict) {
    return {
      blocked: true,
      reason: `Table under maintenance: "${maintConflict.reason || 'scheduled maintenance'}"`,
      conflictType: 'maintenance',
      conflictId: maintConflict.id,
      conflictStart: maintConflict.start_ts,
      conflictEnd: maintConflict.end_ts,
    };
  }

  return { blocked: false };
}

/**
 * Determine the applicable hourly rate for a given start time.
 * Peak if startTs falls within the configured peak window.
 */
function getRate(table, startTs, settings) {
  const peakStart = settings.peak_start; // "HH:MM"
  const peakEnd   = settings.peak_end;

  const d = new Date(startTs);
  // Convert to IST
  const istString = d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour12: false,
    hour: '2-digit', minute: '2-digit' });
  const [hh, mm] = istString.split(':').map(Number);
  const minuteOfDay = hh * 60 + mm;

  const [ph, pm] = peakStart.split(':').map(Number);
  const [eh, em] = peakEnd.split(':').map(Number);
  const peakStartMin = ph * 60 + pm;
  const peakEndMin   = eh * 60 + em;

  const isPeak = minuteOfDay >= peakStartMin && minuteOfDay < peakEndMin;

  if (isPeak && table.peak_rate) {
    return { rate: table.peak_rate, isPeak: true };
  }
  return { rate: table.hourly_rate, isPeak: false };
}

/**
 * Calculate booking price.
 * amount = (rate / 60) * durationMin
 */
function calcPrice(rate, durationMin) {
  return Math.round((rate / 60) * durationMin * 100) / 100;
}

/**
 * Calculate deposit amount based on settings.
 */
function calcDeposit(totalAmount, settings) {
  if (settings.deposit_type === 'flat') {
    return Math.min(parseFloat(settings.deposit_value), totalAmount);
  }
  // percent
  return Math.round(totalAmount * parseFloat(settings.deposit_value) / 100 * 100) / 100;
}

module.exports = { checkOverlap, getRate, calcPrice, calcDeposit };
