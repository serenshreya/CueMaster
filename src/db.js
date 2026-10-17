'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'data', 'cuemaster.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initSchema() {
  const database = getDb();

  database.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK(role IN ('owner','staff')),
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS customers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code   TEXT UNIQUE NOT NULL,
      name            TEXT NOT NULL,
      phone           TEXT UNIQUE NOT NULL,
      no_show_count   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS tables (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      table_code    TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      type          TEXT NOT NULL CHECK(type IN ('snooker','pool')),
      status        TEXT NOT NULL DEFAULT 'available'
                    CHECK(status IN ('available','reserved','in_play','maintenance','disabled')),
      hourly_rate   REAL NOT NULL,
      peak_rate     REAL,
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS maintenance_blocks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      table_id   INTEGER NOT NULL REFERENCES tables(id),
      start_ts   INTEGER NOT NULL,
      end_ts     INTEGER NOT NULL,
      reason     TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_code    TEXT UNIQUE NOT NULL,
      customer_id     INTEGER NOT NULL REFERENCES customers(id),
      table_id        INTEGER NOT NULL REFERENCES tables(id),
      start_ts        INTEGER NOT NULL,
      end_ts          INTEGER NOT NULL,
      duration_min    INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK(status IN ('confirmed','checked_in','in_play','completed','cancelled','no_show')),
      payment_type    TEXT NOT NULL DEFAULT 'pay_at_club'
                      CHECK(payment_type IN ('pay_now','pay_at_club')),
      deposit_status  TEXT NOT NULL DEFAULT 'pending'
                      CHECK(deposit_status IN ('pending','paid','failed','refunded','forfeited','na')),
      deposit_amount  REAL NOT NULL DEFAULT 0,
      grace_deadline  INTEGER,
      cancel_reason   TEXT,
      no_show_reason  TEXT,
      override_reason TEXT,
      rate_at_booking REAL NOT NULL,
      created_by_user INTEGER REFERENCES users(id),
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_bookings_table_status
      ON bookings(table_id, status, start_ts, end_ts);

    CREATE TABLE IF NOT EXISTS sessions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id      INTEGER REFERENCES bookings(id),
      customer_id     INTEGER NOT NULL REFERENCES customers(id),
      table_id        INTEGER NOT NULL REFERENCES tables(id),
      walk_in         INTEGER NOT NULL DEFAULT 0,
      checkin_ts      INTEGER,
      start_ts        INTEGER,
      pause_ts        INTEGER,
      resume_ts       INTEGER,
      end_ts          INTEGER,
      paused_ms       INTEGER NOT NULL DEFAULT 0,
      extended_min    INTEGER NOT NULL DEFAULT 0,
      status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','active','paused','completed')),
      rate_at_session REAL NOT NULL,
      started_by      INTEGER REFERENCES users(id),
      ended_by        INTEGER REFERENCES users(id),
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS bills (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_code  TEXT UNIQUE NOT NULL,
      session_id    INTEGER NOT NULL REFERENCES sessions(id),
      booking_id    INTEGER REFERENCES bookings(id),
      customer_id   INTEGER NOT NULL REFERENCES customers(id),
      table_id      INTEGER NOT NULL REFERENCES tables(id),
      actual_min    INTEGER NOT NULL,
      base_amount   REAL NOT NULL,
      addons_amount REAL NOT NULL DEFAULT 0,
      discount      REAL NOT NULL DEFAULT 0,
      deposit_credit REAL NOT NULL DEFAULT 0,
      total_amount  REAL NOT NULL,
      due_amount    REAL NOT NULL,
      status        TEXT NOT NULL DEFAULT 'unpaid'
                    CHECK(status IN ('unpaid','paid','partial')),
      created_by    INTEGER REFERENCES users(id),
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id       INTEGER REFERENCES bills(id),
      booking_id    INTEGER REFERENCES bookings(id),
      customer_id   INTEGER NOT NULL REFERENCES customers(id),
      type          TEXT NOT NULL
                    CHECK(type IN ('deposit','session_payment','refund','forfeit','partial')),
      amount        REAL NOT NULL,
      mode          TEXT CHECK(mode IN ('cash','upi','card','online','na')),
      note          TEXT,
      created_by    INTEGER REFERENCES users(id),
      created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS bill_addons (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id  INTEGER NOT NULL REFERENCES bills(id),
      name     TEXT NOT NULL,
      amount   REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER REFERENCES users(id),
      customer_id INTEGER REFERENCES customers(id),
      action      TEXT NOT NULL,
      entity_type TEXT,
      entity_id   INTEGER,
      detail      TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    );
  `);
}

module.exports = { getDb, initSchema };
