<div align="center">

<img src="public/brand/logo.svg" alt="KAMUI Logo" width="180" />

# KAMUI (CueMaster)
### *Play · Connect · Belong*

**Next-Generation Snooker, English Pool & Club Operations Platform**

[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-4.18-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white)](https://github.com/WiseLibs/better-sqlite3)
[![Supabase](https://img.shields.io/badge/Supabase-Ready-3ECF8E?logo=supabase&logoColor=white)](https://supabase.com/)
[![Tests](https://img.shields.io/badge/Tests-56%2F56%20Passing-brightgreen?logo=checkmarx&logoColor=white)](test.js)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

</div>

## 📖 Overview

**KAMUI** (built on the award-winning **CueMaster** engine) transforms traditional snooker and pool club management into a Japanese aesthetic-inspired, community-first digital experience. 

It marries consumer-facing delights—such as 3D floor maps, ELO matchmaking, largest-remainder UPI bill splitting, and table-side contactless ordering—with mission-critical club operations including 15-minute conflict prevention buffers, IoT table light control, KOT kitchen displays, and a digital credit ledger (*Khatabook*).

---

## ✨ 8 Signature UI Experiences

| Ref | Page | Route | Key Highlights |
|:---:|:---|:---|:---|
| 🎴 **1** | **Home & Quick Login** | `/` (`index.html`) | • Quick Phone OTP (`1234`) & Guest QR Pass<br>• DigiLocker / Aadhaar KYC verification banner<br>• 5 Community Personas (Gen Z, College, Corporate, Ladies' Hours, Family)<br>• Live Crowd meter & Kamui Loyalty badge |
| 🗺️ **2** | **Live Booking & 3D Floor Map** | `/book` (`booking.html`) | • Interactive 3D floor map with GF/1F/2F floor switcher<br>• Real-time table glow status (Available, Reserved, Occupied) & countdown timers<br>• 3-Step Wizard: Slot picking, Heated Tournament Tables, PS5, Carbon cues, Snacks<br>• Instant UPI Checkout modal |
| 🤝 **3** | **Contri & Matchmaking Hub** | `/contri-hub` (`contri-hub.html`) | • "Find a Snooker Partner" with ELO ratings & Aadhaar badges<br>• Smart Contri Bill Splitter with Loser Pays Table vs Split Food modes<br>• Largest-Remainder exact rupee split algorithm<br>• Individual UPI QR codes & shareable payment links |
| 📱 **4** | **Table QR Experience** | `/table` (`table.html`) | • Contactless Dining menu with customization chips (*Less Ice*, *Extra Cheese*, *Jain*)<br>• One-tap Kitchen Order Ticket (KOT) dispatcher<br>• Live Digital Scoreboard (Race to 7) with Instagram Story export<br>• Closing-Hour Ladies Spin & Win wheel & 10-tier loyalty stamps |
| 📸 **5** | **Scan-to-Get Club Memories** | `/scan-to-get` (`scan-to-get.html`) | • Vintage leather scrapbook design with open album pages<br>• Live camera viewfinder QR scanner<br>• College Friends, Corporate Teams, and Homemakers curated photo streams<br>• High-res ZIP batch download trigger |
| 🧒 **6** | **Junior Academy & Under-14** | `/junior-zone` (`junior-zone.html`) | • Grassroots Coaching progression (Bronze → Silver → Gold → Elite)<br>• Family Bundles (6ft table, 48" cues, step-box, rip-proof cloth)<br>• Birthday Party Builder with pizza packages & mini tournament<br>• Parent Safety Portal: 9 AM–6 PM Curfew, Live CCTV, ₹150 Spend Cap, 4-digit pickup OTP |
| ⛩️ **7** | **Brand Identity & Iconography** | `public/brand/` | • Handcrafted SVG vector with sumi-e Torii gate<br>• Watercolor peach sun & blooming sakura cherry blossom branch<br>• Authentic typography (*Playfair Display*, *Inter*, *Caveat*) |
| 📊 **8** | **Owner & Staff Command Center** | `/staff` (`staff.html`) | • 12 Live Table Sessions grid with active timers (e.g. `28:14 / 60 min`)<br>• IoT Table Light relay switches (ON/OFF sync)<br>• Kitchen Order Ticket (KOT) Kanban board<br>• Digital Khatabook (Credit Ledger) with WhatsApp UPI reminders<br>• Hourly Profit & Expense analytics (56.7% Margin) |

---

## 🏛️ Architecture & Core Engine

```
├── public/                 # Client UI (HTML, CSS, JS, Brand Assets)
│   ├── brand/              # Authentic KAMUI SVG, PNG & favicon
│   ├── css/kamui-theme.css # Shared parchment design system
│   ├── index.html          # [Image 1] Home & Quick Login
│   ├── booking.html        # [Image 2] Floor Map & Booking Engine
│   ├── contri-hub.html     # [Image 3] Matchmaking & Contri Splitter
│   ├── table.html          # [Image 4] Table QR & Scoreboard
│   ├── scan-to-get.html    # [Image 5] Club Memories Scrapbook
│   ├── junior-zone.html    # [Image 6] Junior Academy & Safety Portal
│   ├── staff.html          # [Image 8] Staff & Owner Operations Dashboard
│   └── receipt.html        # Printable Thermal Receipt Generator
├── src/                    # Backend Core (Express + SQLite + Supabase)
│   ├── db.js               # SQLite database client & schema definitions
│   ├── seed.js             # Initial data seeder (tables, users, pricing, KOT)
│   ├── supabase.js         # Supabase client & connection health diagnostics
│   ├── server.js           # Express app, clean URL rewrites, cron jobs
│   └── routes/             # RESTful API Endpoints
│       ├── auth.js         # JWT auth, OTP authentication, staff login
│       ├── bookings.js     # Concurrency guards, 15-min buffers, reservations
│       ├── sessions.js     # Table session lifecycle, start/pause/end/transfer
│       ├── billing.js      # Prorated pricing, add-ons, discounts, payments
│       ├── contri.js       # Bill splitting algorithms & partner discovery
│       ├── orders.js       # Table KOT management & kitchen lifecycle
│       ├── khatabook.js    # Digital credit ledger & WhatsApp payment intents
│       ├── tables.js       # Table status, IoT light toggle relay
│       └── demo.js         # Fast-forward demo clock & auto no-show triggers
├── supabase/               # PostgreSQL Cloud Deployment
│   └── schema.sql          # Complete Supabase migration with GiST constraints
├── test.js                 # Phase 1 test suite (32 tests)
└── test_phase2_3.js        # Phase 2 & 3 test suite (24 tests)
```

### 🔒 Operational Rules Enforced
1. **15-Minute Turnaround Buffer**: Automatically enforces a 15-minute cleaning and cue-chalking buffer between consecutive bookings.
2. **Immediate Transaction Locks**: Prevents race conditions and double bookings on popular tables via `BEGIN IMMEDIATE` transactions and PostgreSQL GiST exclusion ranges.
3. **Session Lifecycle**: Strict state machine: `booked` → `checked_in` → `active` ⇄ `paused` → `completed`.
4. **Append-Only Ledger**: All payments (Cash, UPI, Card) are recorded immutably with running due calculations.
5. **Auto No-Show Engine**: Background daemon periodically scans for unfulfilled bookings, applies prepaid/unpaid grace periods, and forfeits deposits when thresholds are exceeded.

---

## ⚡ Getting Started

### Prerequisites
- **Node.js**: `20.x` or higher
- **npm**: `10.x` or higher

### 1. Clone & Install
```bash
git clone https://github.com/serenshreya/CueMaster.git
cd CueMaster
npm install
```

### 2. Environment Configuration
Create a `.env` file (optional for local SQLite, required for remote Supabase):
```env
PORT=3000
JWT_SECRET=kamui_secret_super_key_2026
SUPABASE_URL=https://tibgfhxiggnkjxfkninl.supabase.co
SUPABASE_ANON_KEY=your_supabase_anon_key
```

### 3. Start the Server
```bash
npm start
```
The application will launch on `http://localhost:3000`.

---

## 🔑 Demo Credentials

| Role | Username / Identifier | Password / OTP | Purpose |
|:---|:---|:---|:---|
| **Club Owner** | `owner` | `owner123` | Full dashboard, financials, Khatabook, system reset |
| **Club Staff** | `staff` | `staff123` | Table timers, IoT light toggle, KOT dispatching |
| **Customer (Demo)**| `9876543210` | `1234` | Member login, self-service bookings, points |
| **Guest Pass** | One-tap Guest Pass | *No OTP required* | Fast booking & floor map exploration |

---

## 🧪 Testing

The platform includes **56 automated test assertions** covering auth, concurrency, session transitions, billing, and the no-show engine.

```bash
# 1. Start the server
node src/server.js

# 2. Run Phase 1 Test Suite (32 tests)
npm test

# 3. Run Phase 2 & 3 Test Suite (24 tests)
node test_phase2_3.js
```

**Results:**
```
Phase 1 Tests:        32 passed, 0 failed (100%)
Phase 2 & 3 Tests:    24 passed, 0 failed (100%)
Total:                56 / 56 passed
```

---

## 🌐 Supabase Integration

The platform provides a **hybrid resilient architecture**:
- **Local Dev / Standalone**: Runs completely self-contained with SQLite for ultra-fast response times and zero cloud dependencies.
- **Cloud Scale (Supabase)**: Ready-to-deploy schema in [`supabase/schema.sql`](supabase/schema.sql) with:
  - Range Exclusion constraint: `EXCLUDE USING gist (table_id WITH =, slot WITH &&)`
  - Row Level Security (RLS) policies
  - Pre-seeded tables, pricing models, and staff accounts
  - Live status endpoint at `GET /api/supabase/status`

---

## 📄 License
This project is licensed under the MIT License.
