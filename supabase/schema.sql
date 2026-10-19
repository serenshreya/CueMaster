-- =========================================================
-- KAMUI / CueMaster — Supabase Database Schema
-- Project URL: https://tibgfhxiggnkjxfkninl.supabase.co
-- =========================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Settings Table
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 2. Staff & Admin Users
CREATE TABLE IF NOT EXISTS public.users (
    id BIGSERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner','staff','kitchen','coach')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Customers Table
CREATE TABLE IF NOT EXISTS public.customers (
    id BIGSERIAL PRIMARY KEY,
    customer_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    no_show_count INT NOT NULL DEFAULT 0,
    loyalty_visits INT NOT NULL DEFAULT 0,
    coins_balance INT NOT NULL DEFAULT 0,
    persona TEXT,
    verified_method TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Tables & Booths
CREATE TABLE IF NOT EXISTS public.tables (
    id BIGSERIAL PRIMARY KEY,
    table_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('snooker','pool','ps5','gaming')),
    status TEXT NOT NULL DEFAULT 'available'
           CHECK(status IN ('available','reserved','in_play','maintenance','disabled')),
    hourly_rate NUMERIC(10,2) NOT NULL,
    peak_rate NUMERIC(10,2),
    iot_light BOOLEAN NOT NULL DEFAULT true,
    floor TEXT DEFAULT 'GF',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Maintenance Blocks
CREATE TABLE IF NOT EXISTS public.maintenance_blocks (
    id BIGSERIAL PRIMARY KEY,
    table_id BIGINT NOT NULL REFERENCES public.tables(id) ON DELETE CASCADE,
    start_ts TIMESTAMPTZ NOT NULL,
    end_ts TIMESTAMPTZ NOT NULL,
    reason TEXT,
    created_by BIGINT REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Bookings Table (with GiST Exclusion Guard)
CREATE TABLE IF NOT EXISTS public.bookings (
    id BIGSERIAL PRIMARY KEY,
    booking_code TEXT UNIQUE NOT NULL,
    customer_id BIGINT NOT NULL REFERENCES public.customers(id),
    table_id BIGINT NOT NULL REFERENCES public.tables(id),
    start_ts TIMESTAMPTZ NOT NULL,
    end_ts TIMESTAMPTZ NOT NULL,
    duration_min INT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed'
           CHECK(status IN ('confirmed','checked_in','in_play','completed','cancelled','no_show')),
    payment_type TEXT NOT NULL DEFAULT 'pay_at_club'
                 CHECK(payment_type IN ('pay_now','pay_at_club')),
    deposit_status TEXT NOT NULL DEFAULT 'pending'
                   CHECK(deposit_status IN ('pending','paid','failed','refunded','forfeited','na')),
    deposit_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    grace_deadline TIMESTAMPTZ,
    cancel_reason TEXT,
    no_show_reason TEXT,
    rate_at_booking NUMERIC(10,2) NOT NULL,
    blocked_range TSTZRANGE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Trigger to maintain blocked_range with 15-min buffer for GiST exclusion
CREATE OR REPLACE FUNCTION public.set_booking_blocked_range()
RETURNS TRIGGER AS $$
BEGIN
    NEW.blocked_range := tstzrange(NEW.start_ts, NEW.end_ts + interval '15 minutes', '[)');
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_booking_range ON public.bookings;
CREATE TRIGGER trg_set_booking_range
BEFORE INSERT OR UPDATE OF start_ts, end_ts ON public.bookings
FOR EACH ROW EXECUTE FUNCTION public.set_booking_blocked_range();

-- GiST exclusion constraint to prevent overlapping active bookings on the same table
ALTER TABLE public.bookings DROP CONSTRAINT IF EXISTS no_overlapping_bookings;
ALTER TABLE public.bookings ADD CONSTRAINT no_overlapping_bookings
EXCLUDE USING gist (
    table_id WITH =,
    blocked_range WITH &&
) WHERE (status IN ('confirmed','checked_in','in_play'));

-- 7. Sessions Table
CREATE TABLE IF NOT EXISTS public.sessions (
    id BIGSERIAL PRIMARY KEY,
    booking_id BIGINT REFERENCES public.bookings(id),
    customer_id BIGINT NOT NULL REFERENCES public.customers(id),
    table_id BIGINT NOT NULL REFERENCES public.tables(id),
    walk_in INT NOT NULL DEFAULT 0,
    checkin_ts TIMESTAMPTZ,
    start_ts TIMESTAMPTZ,
    pause_ts TIMESTAMPTZ,
    resume_ts TIMESTAMPTZ,
    end_ts TIMESTAMPTZ,
    paused_ms BIGINT NOT NULL DEFAULT 0,
    extended_min INT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending'
           CHECK(status IN ('pending','active','paused','completed')),
    rate_at_session NUMERIC(10,2) NOT NULL,
    started_by BIGINT REFERENCES public.users(id),
    ended_by BIGINT REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. Bills Table
CREATE TABLE IF NOT EXISTS public.bills (
    id BIGSERIAL PRIMARY KEY,
    receipt_code TEXT UNIQUE NOT NULL,
    session_id BIGINT NOT NULL REFERENCES public.sessions(id),
    booking_id BIGINT REFERENCES public.bookings(id),
    customer_id BIGINT NOT NULL REFERENCES public.customers(id),
    table_id BIGINT NOT NULL REFERENCES public.tables(id),
    actual_min INT NOT NULL,
    base_amount NUMERIC(10,2) NOT NULL,
    addons_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount NUMERIC(10,2) NOT NULL DEFAULT 0,
    deposit_credit NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_amount NUMERIC(10,2) NOT NULL,
    due_amount NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'unpaid'
           CHECK(status IN ('unpaid','paid','partial')),
    created_by BIGINT REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. Bill Addons
CREATE TABLE IF NOT EXISTS public.bill_addons (
    id BIGSERIAL PRIMARY KEY,
    bill_id BIGINT NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    amount NUMERIC(10,2) NOT NULL
);

-- 10. Payments Table (Append-Only)
CREATE TABLE IF NOT EXISTS public.payments (
    id BIGSERIAL PRIMARY KEY,
    bill_id BIGINT REFERENCES public.bills(id),
    booking_id BIGINT REFERENCES public.bookings(id),
    customer_id BIGINT NOT NULL REFERENCES public.customers(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','session_payment','refund','forfeit','partial')),
    amount NUMERIC(10,2) NOT NULL,
    mode TEXT CHECK(mode IN ('cash','upi','card','online','na')),
    note TEXT,
    created_by BIGINT REFERENCES public.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 11. Kitchen Order Tickets (KOT)
CREATE TABLE IF NOT EXISTS public.orders (
    id BIGSERIAL PRIMARY KEY,
    order_code TEXT UNIQUE NOT NULL,
    table_id BIGINT NOT NULL,
    items_summary TEXT NOT NULL,
    total_amount NUMERIC(10,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'preparing'
           CHECK(status IN ('preparing','ready','on_hold','completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 12. Activity Log
CREATE TABLE IF NOT EXISTS public.activity_log (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES public.users(id),
    customer_id BIGINT REFERENCES public.customers(id),
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id BIGINT,
    detail JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed Default Settings
INSERT INTO public.settings(key, value) VALUES
  ('club_name', 'KAMUI Snooker & Pool Club'),
  ('club_address', '42 MG Road, Bengaluru, Karnataka 560001'),
  ('club_phone', '+91 98765 43210'),
  ('opening_hour', '10:00'),
  ('closing_hour', '23:00'),
  ('min_duration_min', '30'),
  ('booking_buffer_min', '15'),
  ('peak_start', '17:00'),
  ('peak_end', '22:00'),
  ('peak_multiplier', '1.5'),
  ('currency_symbol', 'Rs.')
ON CONFLICT (key) DO NOTHING;

-- Seed Default Tables
INSERT INTO public.tables(table_code, name, type, status, hourly_rate, peak_rate, iot_light) VALUES
  ('T-001', 'Table 1', 'snooker', 'available', 400.00, 600.00, true),
  ('T-002', 'Table 2', 'snooker', 'available', 400.00, 600.00, true),
  ('T-003', 'Table 3', 'snooker', 'available', 350.00, 525.00, true),
  ('T-004', 'Table 4', 'snooker', 'available', 350.00, 525.00, true),
  ('T-005', 'Table 5', 'pool',    'maintenance', 250.00, 375.00, false),
  ('T-006', 'Table 6', 'pool',    'available', 250.00, 375.00, true)
ON CONFLICT (table_code) DO NOTHING;
