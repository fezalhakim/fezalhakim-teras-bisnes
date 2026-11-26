import { Router } from "express";
import { requireRole } from "../auth.js";
import { tx, postJournal, audit, round2 } from "../db.js";
import { str, num, date, InputError, h, today } from "../util.js";

const SST_RATES = [0, 5, 6, 8, 10];

export default function financeRoutes(db) {
  const r = Router();
  r.use(requireRole("kewangan"));

  r.get("/accounts", (req, res) => {
    res.json(db.prepare(`
      SELECT a.*, COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
      FROM accounts a LEFT JOIN journal_lines l ON l.account_id = a.id
      GROUP BY a.id ORDER BY a.code`).all());
  });

  r.post("/accounts", h((req, res) => {
    const code = str(req.body.code, "Kod", { max: 10 });
    const type = req.body.type;
    if (!["aset", "liabiliti", "ekuiti", "hasil", "belanja"].includes(type)) throw new InputError("Jenis akaun tidak sah.");
    if (db.prepare("SELECT 1 FROM accounts WHERE code = ?").get(code)) throw new InputError("Kod akaun sudah wujud.");
    const { lastInsertRowid } = db.prepare("INSERT INTO accounts (code, name, type) VALUES (?, ?, ?)").run(code, str(req.body.name, "Nama", { max: 100 }), type);
    res.json({ id: Number(lastInsertRowid) });
  }));

  // ===== Invois =====
  r.get("/invoices", (req, res) => {
    res.json(db.prepare("SELECT * FROM invoices ORDER BY id DESC LIMIT 500").all());
  });

  r.get("/invoices/:id", h((req, res) => {
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
    if (!inv) throw new InputError("Invois tiada.", 404);
    inv.lines = db.prepare("SELECT * FROM invoice_lines WHERE invoice_id = ?").all(inv.id);
    inv.payments = db.prepare("SELECT * FROM payments WHERE invoice_id = ? ORDER BY pay_date").all(inv.id);
    res.json(inv);
  }));

  // Invois: Dt Akaun Belum Terima / Kt Jualan + Kt SST Perlu Dibayar.
  r.post("/invoices", h((req, res) => {
    const issue = date(req.body.issue_date || today(), "Tarikh invois");
    const due = date(req.body.due_date, "Tarikh akhir bayar", { required: false });
    const customer = str(req.body.customer_name, "Nama pelanggan", { max: 200 });
    const contactId = Number(req.body.contact_id) || null;
    const raw = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!raw.length || raw.length > 100) throw new InputError("Invois perlu sekurang-kurangnya satu baris.");
    const lines = raw.map((l, i) => {
      const qty = num(l.qty, `Kuantiti baris ${i + 1}`, { min: 0.0001, max: 1e7 });
      const price = num(l.unit_price, `Harga baris ${i + 1}`, { min: 0, max: 1e9 });
      const rate = Number(l.sst_rate || 0);
      if (!SST_RATES.includes(rate)) throw new InputError(`Kadar SST baris ${i + 1} tidak sah.`);
      const amount = round2(qty * price);
      return { description: str(l.description, `Keterangan baris ${i + 1}`), qty, price, rate, amount, sst: round2(amount * rate / 100) };
    });
    const subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
    const sst = round2(lines.reduce((s, l) => s + l.sst, 0));
    const total = round2(subtotal + sst);
    if (total <= 0) throw new InputError("Jumlah invois mesti lebih daripada sifar.");

    const out = tx(db, () => {
      const year = issue.slice(0, 4);
      const n = db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE number LIKE ?").get(`INV-${year}-%`).n + 1;
      const number = `INV-${year}-${String(n).padStart(4, "0")}`;
      const id = Number(db.prepare(`INSERT INTO invoices (number, contact_id, customer_name, issue_date, due_date, subtotal, sst_total, total, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(number, contactId, customer, issue, due, subtotal, sst, total, str(req.body.notes, "Nota", { required: false, max: 1000 })).lastInsertRowid);
      const ins = db.prepare(`INSERT INTO invoice_lines (invoice_id, description, qty, unit_price, sst_rate, amount, sst_amount) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const l of lines) ins.run(id, l.description, l.qty, l.price, l.rate, l.amount, l.sst);
      const jid = postJournal(db, {
        date: issue, memo: `Invois ${number} – ${customer}`, source: "invois", sourceId: id, userId: req.user.id,
        lines: [{ code: "1100", debit: total }, { code: "4000", credit: subtotal }, { code: "2100", credit: sst }],
      });
      db.prepare("UPDATE invoices SET journal_id = ? WHERE id = ?").run(jid, id);
      return { id, number, total };
    });
    audit(db, req.user.id, "cipta_invois", out);
    res.json(out);
  }));

  // Terima bayaran: Dt Tunai di Bank / Kt Akaun Belum Terima.
  r.post("/invoices/:id/payments", h((req, res) => {
    const inv = db.prepare("SELECT * FROM invoices WHERE id = ?").get(Number(req.params.id));
    if (!inv) throw new InputError("Invois tiada.", 404);
    const amount = round2(num(req.body.amount, "Jumlah", { min: 0.01 }));
    const outstanding = round2(inv.total - inv.paid);
    if (amount > outstanding) throw new InputError(`Jumlah melebihi baki tertunggak (RM ${outstanding.toFixed(2)}).`);
    const payDate = date(req.body.pay_date || today(), "Tarikh bayaran");
    tx(db, () => {
      const pid = Number(db.prepare("INSERT INTO payments (invoice_id, pay_date, amount, method) VALUES (?, ?, ?, ?)")
        .run(inv.id, payDate, amount, str(req.body.method, "Kaedah", { required: false, max: 50 })).lastInsertRowid);
      const jid = postJournal(db, {
        date: payDate, memo: `Bayaran ${inv.number}`, source: "bayaran", sourceId: pid, userId: req.user.id,
        lines: [{ code: "1000", debit: amount }, { code: "1100", credit: amount }],
      });
      db.prepare("UPDATE payments SET journal_id = ? WHERE id = ?").run(jid, pid);
      const paid = round2(inv.paid + amount);
      db.prepare("UPDATE invoices SET paid = ?, status = ? WHERE id = ?").run(paid, paid >= inv.total ? "dibayar" : "separa", inv.id);
    });
    audit(db, req.user.id, "terima_bayaran", { invoice: inv.number, amount });
    res.json({ ok: true });
  }));

  // ===== Perbelanjaan =====
  r.get("/expenses", (req, res) => {
    res.json(db.prepare(`SELECT x.*, a.code, a.name AS account_name FROM expenses x JOIN accounts a ON a.id = x.account_id ORDER BY x.expense_date DESC, x.id DESC LIMIT 500`).all());
  });

  // Belanja: Dt akaun belanja / Kt Tunai di Bank.
  r.post("/expenses", h((req, res) => {
    const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(Number(req.body.account_id));
    if (!acc || acc.type !== "belanja") throw new InputError("Pilih akaun belanja yang sah.");
    const d = date(req.body.expense_date || today(), "Tarikh");
    const vendor = str(req.body.vendor, "Pembekal", { max: 200 });
    const amount = round2(num(req.body.amount, "Jumlah", { min: 0.01, max: 1e9 }));
    const id = tx(db, () => {
      const id = Number(db.prepare("INSERT INTO expenses (expense_date, vendor, account_id, description, amount) VALUES (?, ?, ?, ?, ?)")
        .run(d, vendor, acc.id, str(req.body.description, "Keterangan", { required: false }), amount).lastInsertRowid);
      const jid = postJournal(db, {
        date: d, memo: `Belanja – ${vendor}`, source: "belanja", sourceId: id, userId: req.user.id,
        lines: [{ account_id: acc.id, debit: amount }, { code: "1000", credit: amount }],
      });
      db.prepare("UPDATE expenses SET journal_id = ? WHERE id = ?").run(jid, id);
      return id;
    });
    audit(db, req.user.id, "rekod_belanja", { id, amount });
    res.json({ id });
  }));

  // ===== Jurnal =====
  r.get("/journal", (req, res) => {
    const entries = db.prepare(`SELECT j.*, u.name AS user_name FROM journal_entries j LEFT JOIN users u ON u.id = j.created_by ORDER BY j.id DESC LIMIT 200`).all();
    const lines = db.prepare(`SELECT l.*, a.code, a.name FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = ?`);
    res.json(entries.map((e) => ({ ...e, lines: lines.all(e.id) })));
  });

  // Catatan manual (cth modal permulaan, pembetulan/pembalikan).
  r.post("/journal", h((req, res) => {
    const d = date(req.body.entry_date || today(), "Tarikh");
    const lines = (Array.isArray(req.body.lines) ? req.body.lines : []).map((l) => {
      const acc = db.prepare("SELECT id FROM accounts WHERE id = ?").get(Number(l.account_id));
      if (!acc) throw new InputError("Akaun tidak sah dalam baris jurnal.");
      return { account_id: acc.id, debit: num(l.debit || 0, "Debit", { min: 0 }), credit: num(l.credit || 0, "Kredit", { min: 0 }) };
    });
    let id;
    try {
      id = tx(db, () => postJournal(db, { date: d, memo: str(req.body.memo, "Memo", { max: 300 }), source: "manual", userId: req.user.id, lines }));
    } catch (e) {
      if (e instanceof InputError) throw e;
      throw new InputError(e.message);
    }
    audit(db, req.user.id, "jurnal_manual", { id });
    res.json({ id });
  }));

  // ===== Laporan =====
  const balances = (from, to) => db.prepare(`
    SELECT a.id, a.code, a.name, a.type,
      COALESCE(SUM(l.debit), 0) AS debit, COALESCE(SUM(l.credit), 0) AS credit
    FROM accounts a
    LEFT JOIN journal_lines l ON l.account_id = a.id
      AND l.entry_id IN (SELECT id FROM journal_entries WHERE entry_date BETWEEN ? AND ?)
    GROUP BY a.id ORDER BY a.code`).all(from, to)
    .map((a) => ({ ...a, debit: round2(a.debit), credit: round2(a.credit) }));

  r.get("/reports/trial-balance", h((req, res) => {
    const to = date(req.query.to || today(), "Hingga");
    const rows = balances("0000-01-01", to).filter((a) => a.debit || a.credit)
      .map((a) => { const b = round2(a.debit - a.credit); return { ...a, dr: b > 0 ? b : 0, cr: b < 0 ? -b : 0 }; });
    res.json({ to, rows, totalDr: round2(rows.reduce((s, x) => s + x.dr, 0)), totalCr: round2(rows.reduce((s, x) => s + x.cr, 0)) });
  }));

  r.get("/reports/profit-loss", h((req, res) => {
    const from = date(req.query.from || today().slice(0, 4) + "-01-01", "Dari");
    const to = date(req.query.to || today(), "Hingga");
    const rows = balances(from, to);
    const revenue = rows.filter((a) => a.type === "hasil").map((a) => ({ code: a.code, name: a.name, amount: round2(a.credit - a.debit) })).filter((a) => a.amount);
    const expenses = rows.filter((a) => a.type === "belanja").map((a) => ({ code: a.code, name: a.name, amount: round2(a.debit - a.credit) })).filter((a) => a.amount);
    const totalRevenue = round2(revenue.reduce((s, a) => s + a.amount, 0));
    const totalExpenses = round2(expenses.reduce((s, a) => s + a.amount, 0));
    res.json({ from, to, revenue, expenses, totalRevenue, totalExpenses, profit: round2(totalRevenue - totalExpenses) });
  }));

  r.get("/reports/balance-sheet", h((req, res) => {
    const to = date(req.query.to || today(), "Hingga");
    const rows = balances("0000-01-01", to);
    const pick = (type, sign) => rows.filter((a) => a.type === type)
      .map((a) => ({ code: a.code, name: a.name, amount: round2(sign * (a.debit - a.credit)) })).filter((a) => a.amount);
    const assets = pick("aset", 1), liabilities = pick("liabiliti", -1), equity = pick("ekuiti", -1);
    const earnings = round2(rows.filter((a) => a.type === "hasil").reduce((s, a) => s + a.credit - a.debit, 0)
      - rows.filter((a) => a.type === "belanja").reduce((s, a) => s + a.debit - a.credit, 0));
    if (earnings) equity.push({ code: "—", name: "Untung Terkumpul", amount: earnings });
    const sum = (xs) => round2(xs.reduce((s, a) => s + a.amount, 0));
    res.json({ to, assets, liabilities, equity, totalAssets: sum(assets), totalLiabilities: sum(liabilities), totalEquity: sum(equity) });
  }));

  // Ringkasan SST untuk tempoh (dari baris invois).
  r.get("/reports/sst", h((req, res) => {
    const from = date(req.query.from || today().slice(0, 8) + "01", "Dari");
    const to = date(req.query.to || today(), "Hingga");
    res.json({ from, to, rows: db.prepare(`
      SELECT l.sst_rate, ROUND(SUM(l.amount), 2) AS taxable, ROUND(SUM(l.sst_amount), 2) AS sst
      FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE i.issue_date BETWEEN ? AND ? GROUP BY l.sst_rate ORDER BY l.sst_rate`).all(from, to) });
  }));

  return r;
}
