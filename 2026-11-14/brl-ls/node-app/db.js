// SQLite storage (file: data/app.db). Zero setup; back it up by copying the file.
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data', 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS divisions (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, cn_prefix TEXT DEFAULT '', cn_next INTEGER DEFAULT 1001, active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS supervisors (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, mobile TEXT, pin TEXT, branch TEXT NOT NULL, division TEXT,
  role TEXT DEFAULT 'Supervisor', active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS branches (
  name TEXT PRIMARY KEY, address TEXT, phone TEXT, email TEXT, lat REAL, lng REAL, billing_default TEXT
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, code TEXT NOT NULL, name TEXT, branch TEXT, division TEXT,
  type TEXT NOT NULL, lat REAL, lng REAL, accuracy REAL, address TEXT, photo TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_day ON attendance(code, day);
CREATE TABLE IF NOT EXISTS lrs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, cn_no TEXT UNIQUE NOT NULL, pickup_date TEXT, trip_id TEXT,
  code TEXT NOT NULL, supervisor TEXT, branch TEXT, division TEXT, booking_type TEXT, loading_station TEXT, delivery_station TEXT,
  vehicle_no TEXT, load_type TEXT, consignor TEXT, consignor_gstin TEXT, consignee TEXT, consignee_gstin TEXT,
  ewb_no TEXT, valid_till TEXT, invoice_no TEXT, invoice_date TEXT, invoice_value TEXT, packages REAL,
  actual_wt TEXT, charged_wt TEXT, basis TEXT, driver_phone TEXT, consignee_pdf TEXT, driver_pdf TEXT, data TEXT
);
CREATE TABLE IF NOT EXISTS ewb_cache (
  ewb_no TEXT PRIMARY KEY, fetched_at TEXT, fetched_by TEXT, raw TEXT
);
CREATE TABLE IF NOT EXISTS otps (
  mobile TEXT PRIMARY KEY, otp_hash TEXT NOT NULL, expires INTEGER NOT NULL, attempts INTEGER DEFAULT 0, sent_at INTEGER, last_otp TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// Light migrations for databases created by the earlier version.
function addCol(table, col, type) { const has = db.prepare('PRAGMA table_info(' + table + ')').all().some(c => c.name === col); if (!has) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + type); }
addCol('supervisors', 'division', 'TEXT'); addCol('attendance', 'division', 'TEXT'); addCol('lrs', 'division', 'TEXT');

// Default divisions
db.prepare("INSERT OR IGNORE INTO divisions(code,name,cn_prefix,cn_next) VALUES('JNPTC','Container Division','JNPTC/',1001)").run();
db.prepare("INSERT OR IGNORE INTO divisions(code,name,cn_prefix,cn_next) VALUES('JNPT-E','Booking Division','JNPTE/',1001)").run();

const getSetting = (k, d) => { const r = db.prepare('SELECT value FROM settings WHERE key=?').get(k); return r ? r.value : d; };
const setSetting = (k, v) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v));

module.exports = { db, getSetting, setSetting };
