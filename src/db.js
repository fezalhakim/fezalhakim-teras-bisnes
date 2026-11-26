import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- ===== Teras: pengguna, sesi, tetapan =====
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','pengurus','kewangan','pekerja')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== HR =====
CREATE TABLE IF NOT EXISTS employees (
  id INTEGER PRIMARY KEY,
  user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  ic_no TEXT,
  position TEXT,
  department TEXT,
  join_date TEXT,
  basic_salary REAL NOT NULL DEFAULT 0,
  manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  annual_leave_days REAL NOT NULL DEFAULT 14,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  in_lat REAL, in_lng REAL,
  out_lat REAL, out_lng REAL,
  UNIQUE (employee_id, work_date)
);
CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  leave_type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'menunggu' CHECK (status IN ('menunggu','lulus','ditolak')),
  decided_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  claim_date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  status TEXT NOT NULL DEFAULT 'menunggu' CHECK (status IN ('menunggu','lulus','ditolak','dibayar')),
  decided_by INTEGER REFERENCES users(id),
  journal_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS payslips (
  id INTEGER PRIMARY KEY,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period TEXT NOT NULL,             -- 'YYYY-MM'
  basic REAL NOT NULL,
  allowances REAL NOT NULL DEFAULT 0,
  other_deductions REAL NOT NULL DEFAULT 0,
  epf_employee REAL NOT NULL DEFAULT 0,
  epf_employer REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL,
  journal_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (employee_id, period)
);

-- ===== Perakaunan (catatan bergu) =====
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('aset','liabiliti','ekuiti','hasil','belanja'))
);
CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL,
  memo TEXT,
  source TEXT,                       -- 'invois','bayaran','belanja','gaji','tuntutan','manual'
  source_id INTEGER,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS journal_lines (
  id INTEGER PRIMARY KEY,
  entry_id INTEGER NOT NULL REFERENCES journal_entries(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0
);
-- Jejak audit: catatan jurnal tidak boleh diubah atau dipadam. Betulkan dengan catatan pembalikan.
CREATE TRIGGER IF NOT EXISTS no_update_journal_lines BEFORE UPDATE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'Catatan jurnal tidak boleh diubah'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_journal_lines BEFORE DELETE ON journal_lines
BEGIN SELECT RAISE(ABORT, 'Catatan jurnal tidak boleh dipadam'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_journal_entries BEFORE DELETE ON journal_entries
BEGIN SELECT RAISE(ABORT, 'Catatan jurnal tidak boleh dipadam'); END;

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT,
  subtotal REAL NOT NULL,
  sst_total REAL NOT NULL,
  total REAL NOT NULL,
  paid REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'belum_bayar' CHECK (status IN ('belum_bayar','separa','dibayar')),
  notes TEXT,
  journal_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  qty REAL NOT NULL,
  unit_price REAL NOT NULL,
  sst_rate REAL NOT NULL DEFAULT 0,  -- peratus, cth 6 atau 8
  amount REAL NOT NULL,
  sst_amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  pay_date TEXT NOT NULL,
  amount REAL NOT NULL CHECK (amount > 0),
  method TEXT,
  journal_id INTEGER REFERENCES journal_entries(id)
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  expense_date TEXT NOT NULL,
  vendor TEXT NOT NULL,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  description TEXT,
  amount REAL NOT NULL CHECK (amount > 0),
  journal_id INTEGER REFERENCES journal_entries(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===== CRM =====
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  company TEXT,
  phone TEXT,
  email TEXT,
  source TEXT,
  notes TEXT,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS deals (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  value REAL NOT NULL DEFAULT 0,
  stage TEXT NOT NULL DEFAULT 'baru' CHECK (stage IN ('baru','dihubungi','sebut_harga','rundingan','menang','kalah')),
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expected_close TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  deal_id INTEGER REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  note TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Carta akaun asas untuk syarikat kecil di Malaysia.
const DEFAULT_ACCOUNTS = [
  ["1000", "Tunai di Bank", "aset"],
  ["1100", "Akaun Belum Terima", "aset"],
  ["2000", "Akaun Belum Bayar", "liabiliti"],
  ["2100", "SST Perlu Dibayar", "liabiliti"],
  ["2200", "KWSP Perlu Dibayar", "liabiliti"],
  ["2300", "Gaji Perlu Dibayar", "liabiliti"],
  ["2400", "Tuntutan Pekerja Perlu Dibayar", "liabiliti"],
  ["3000", "Modal Pemilik", "ekuiti"],
  ["4000", "Jualan", "hasil"],
  ["4100", "Hasil Lain", "hasil"],
  ["5000", "Gaji & Upah", "belanja"],
  ["5010", "Caruman KWSP Majikan", "belanja"],
  ["5100", "Sewa", "belanja"],
  ["5200", "Utiliti", "belanja"],
  ["5300", "Pemasaran & Iklan", "belanja"],
  ["5400", "Perjalanan & Tuntutan", "belanja"],
  ["5500", "Peralatan & Perisian", "belanja"],
  ["5900", "Belanja Am", "belanja"],
];

export function openDb(file = process.env.DB_PATH || "data/teras.db") {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const count = db.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  if (count === 0) {
    const ins = db.prepare("INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)");
    for (const a of DEFAULT_ACCOUNTS) ins.run(...a);
  }
  return db;
}

// Jalankan fungsi dalam satu transaksi; batal jika ada ralat.
export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

export function accountId(db, code) {
  const row = db.prepare("SELECT id FROM accounts WHERE code = ?").get(code);
  if (!row) throw new Error(`Akaun ${code} tiada`);
  return row.id;
}

// Rekod catatan bergu. lines: [{code|account_id, debit, credit}]. Mesti seimbang.
export function postJournal(db, { date, memo, source, sourceId, userId, lines }) {
  let dr = 0, cr = 0;
  const resolved = lines
    .map((l) => ({
      account_id: l.account_id ?? accountId(db, l.code),
      debit: round2(l.debit || 0),
      credit: round2(l.credit || 0),
    }))
    .filter((l) => l.debit !== 0 || l.credit !== 0);
  for (const l of resolved) { dr += l.debit; cr += l.credit; }
  if (resolved.length < 2 || round2(dr) !== round2(cr)) {
    throw new Error(`Jurnal tidak seimbang (Dt ${round2(dr)} / Kt ${round2(cr)})`);
  }
  const { lastInsertRowid } = db
    .prepare("INSERT INTO journal_entries (entry_date, memo, source, source_id, created_by) VALUES (?, ?, ?, ?, ?)")
    .run(date, memo ?? null, source ?? "manual", sourceId ?? null, userId ?? null);
  const ins = db.prepare("INSERT INTO journal_lines (entry_id, account_id, debit, credit) VALUES (?, ?, ?, ?)");
  for (const l of resolved) ins.run(lastInsertRowid, l.account_id, l.debit, l.credit);
  return Number(lastInsertRowid);
}

export function audit(db, userId, action, detail) {
  db.prepare("INSERT INTO audit_log (user_id, action, detail) VALUES (?, ?, ?)").run(
    userId ?? null, action, detail == null ? null : JSON.stringify(detail)
  );
}
