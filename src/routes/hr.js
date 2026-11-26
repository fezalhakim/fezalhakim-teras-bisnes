import { Router } from "express";
import { requireAuth, requireRole } from "../auth.js";
import { tx, postJournal, audit, round2 } from "../db.js";
import { str, num, date, oneOf, InputError, h, today } from "../util.js";

const LEAVE_TYPES = ["tahunan", "sakit", "kecemasan", "tanpa_gaji", "lain"];
const CLAIM_CATEGORIES = ["perjalanan", "makan", "minyak", "parking", "peralatan", "lain"];

// Kadar KWSP ringkas (anggaran): pekerja 11%; majikan 13% jika gaji <= RM5,000, 12% jika lebih.
// Jadual rasmi KWSP membundarkan mengikut julat gaji. Semak semula dengan jadual KWSP sebelum bayaran sebenar.
export function epf(wage) {
  return {
    employee: Math.ceil(wage * 0.11),
    employer: Math.ceil(wage * (wage <= 5000 ? 0.13 : 0.12)),
  };
}

// Tarikh jurnal gaji: hari akhir bulan itu, atau hari ini jika bulan itu belum tamat.
export function payrollDate(period, now = today()) {
  const [y, m] = period.split("-").map(Number);
  const last = `${period}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  return now.startsWith(period) && now < last ? now : last;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
}

export default function hrRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  const isManager = (u) => ["admin", "pengurus"].includes(u.role);
  const needEmployee = (req) => {
    if (!req.user.employee_id) throw new InputError("Akaun anda belum dipautkan kepada rekod pekerja. Hubungi admin.", 403);
    return req.user.employee_id;
  };
  const leaveBalance = (empId, year) => {
    const e = db.prepare("SELECT annual_leave_days FROM employees WHERE id = ?").get(empId);
    const used = db.prepare(`SELECT COALESCE(SUM(days), 0) AS d FROM leave_requests
      WHERE employee_id = ? AND leave_type = 'tahunan' AND status IN ('lulus','menunggu') AND substr(start_date, 1, 4) = ?`).get(empId, String(year)).d;
    return { entitled: e?.annual_leave_days ?? 0, used, balance: round2((e?.annual_leave_days ?? 0) - used) };
  };

  // ===== Pekerja =====
  r.get("/employees", requireRole("pengurus", "kewangan"), (req, res) => {
    res.json(db.prepare(`
      SELECT e.*, m.name AS manager_name, u.email, u.role
      FROM employees e LEFT JOIN employees m ON m.id = e.manager_id LEFT JOIN users u ON u.id = e.user_id
      ORDER BY e.active DESC, e.name`).all());
  });

  const readEmployee = (b) => ({
    name: str(b.name, "Nama", { max: 120 }),
    ic_no: str(b.ic_no, "No. KP", { required: false, max: 20 }),
    position: str(b.position, "Jawatan", { required: false, max: 80 }),
    department: str(b.department, "Jabatan", { required: false, max: 80 }),
    join_date: date(b.join_date, "Tarikh mula", { required: false }),
    basic_salary: num(b.basic_salary ?? 0, "Gaji pokok", { min: 0, max: 1e7 }),
    manager_id: Number(b.manager_id) || null,
    annual_leave_days: num(b.annual_leave_days ?? 14, "Cuti tahunan", { min: 0, max: 365 }),
    active: b.active === false || b.active === 0 ? 0 : 1,
  });

  r.post("/employees", requireRole("pengurus"), h((req, res) => {
    const e = readEmployee(req.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO employees
      (name, ic_no, position, department, join_date, basic_salary, manager_id, annual_leave_days, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(e.name, e.ic_no, e.position, e.department, e.join_date, e.basic_salary, e.manager_id, e.annual_leave_days, e.active);
    audit(db, req.user.id, "cipta_pekerja", { id: Number(lastInsertRowid), name: e.name });
    res.json({ id: Number(lastInsertRowid) });
  }));

  r.put("/employees/:id", requireRole("pengurus"), h((req, res) => {
    const id = Number(req.params.id);
    const e = readEmployee(req.body);
    if (e.manager_id === id) throw new InputError("Pekerja tidak boleh menjadi pengurus dirinya sendiri.");
    const info = db.prepare(`UPDATE employees SET name=?, ic_no=?, position=?, department=?, join_date=?, basic_salary=?, manager_id=?, annual_leave_days=?, active=? WHERE id=?`)
      .run(e.name, e.ic_no, e.position, e.department, e.join_date, e.basic_salary, e.manager_id, e.annual_leave_days, e.active, id);
    if (!info.changes) throw new InputError("Pekerja tiada.", 404);
    audit(db, req.user.id, "kemas_kini_pekerja", { id });
    res.json({ ok: true });
  }));

  r.get("/me", h((req, res) => {
    const empId = needEmployee(req);
    res.json({
      employee: db.prepare("SELECT id, name, position, department, join_date, annual_leave_days FROM employees WHERE id = ?").get(empId),
      today: db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?").get(empId, today()) ?? null,
      leave: leaveBalance(empId, today().slice(0, 4)),
    });
  }));

  // ===== Kehadiran =====
  r.post("/clock", h((req, res) => {
    const empId = needEmployee(req);
    const lat = num(req.body.lat, "Latitud", { required: false, min: -90, max: 90 });
    const lng = num(req.body.lng, "Longitud", { required: false, min: -180, max: 180 });
    const d = today();
    const now = new Date().toISOString();
    const row = db.prepare("SELECT * FROM attendance WHERE employee_id = ? AND work_date = ?").get(empId, d);
    if (!row) {
      db.prepare("INSERT INTO attendance (employee_id, work_date, clock_in, in_lat, in_lng) VALUES (?, ?, ?, ?, ?)").run(empId, d, now, lat, lng);
      return res.json({ action: "masuk", at: now });
    }
    if (!row.clock_out) {
      db.prepare("UPDATE attendance SET clock_out = ?, out_lat = ?, out_lng = ? WHERE id = ?").run(now, lat, lng, row.id);
      return res.json({ action: "keluar", at: now });
    }
    throw new InputError("Anda sudah clock-in dan clock-out hari ini.");
  }));

  r.get("/attendance", h((req, res) => {
    const from = date(req.query.from || today().slice(0, 8) + "01", "Dari");
    const to = date(req.query.to || today(), "Hingga");
    const all = isManager(req.user) && req.query.all === "1";
    if (!all) needEmployee(req);
    res.json(db.prepare(`
      SELECT a.*, e.name FROM attendance a JOIN employees e ON e.id = a.employee_id
      WHERE a.work_date BETWEEN ? AND ? ${all ? "" : "AND a.employee_id = ?"}
      ORDER BY a.work_date DESC, e.name`).all(...(all ? [from, to] : [from, to, req.user.employee_id])));
  }));

  // ===== Cuti =====
  r.get("/leave", h((req, res) => {
    const all = isManager(req.user) && req.query.all === "1";
    if (!all) needEmployee(req);
    res.json(db.prepare(`
      SELECT l.*, e.name, u.name AS decided_by_name FROM leave_requests l
      JOIN employees e ON e.id = l.employee_id LEFT JOIN users u ON u.id = l.decided_by
      ${all ? "" : "WHERE l.employee_id = ?"} ORDER BY l.id DESC LIMIT 300`).all(...(all ? [] : [req.user.employee_id])));
  }));

  r.post("/leave", h((req, res) => {
    const empId = needEmployee(req);
    const leave_type = oneOf(req.body.leave_type, "Jenis cuti", LEAVE_TYPES);
    const start = date(req.body.start_date, "Tarikh mula");
    const end = date(req.body.end_date, "Tarikh akhir");
    if (end < start) throw new InputError("Tarikh akhir mesti selepas tarikh mula.");
    const days = req.body.half_day ? 0.5 : daysBetween(start, end);
    if (days > 60) throw new InputError("Tempoh cuti terlalu panjang.");
    if (leave_type === "tahunan") {
      const bal = leaveBalance(empId, start.slice(0, 4));
      if (days > bal.balance) throw new InputError(`Baki cuti tahunan tidak cukup (baki ${bal.balance} hari).`);
    }
    const overlap = db.prepare(`SELECT 1 FROM leave_requests WHERE employee_id = ? AND status != 'ditolak'
      AND start_date <= ? AND end_date >= ?`).get(empId, end, start);
    if (overlap) throw new InputError("Tarikh ini bertindih dengan permohonan cuti lain.");
    const { lastInsertRowid } = db.prepare(`INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days, reason)
      VALUES (?, ?, ?, ?, ?, ?)`).run(empId, leave_type, start, end, days, str(req.body.reason, "Sebab", { required: false }));
    res.json({ id: Number(lastInsertRowid) });
  }));

  r.post("/leave/:id/decide", requireRole("pengurus"), h((req, res) => {
    const status = oneOf(req.body.status, "Keputusan", ["lulus", "ditolak"]);
    const row = db.prepare("SELECT * FROM leave_requests WHERE id = ?").get(Number(req.params.id));
    if (!row) throw new InputError("Permohonan tiada.", 404);
    if (row.status !== "menunggu") throw new InputError("Permohonan ini sudah diputuskan.");
    if (row.employee_id === req.user.employee_id) throw new InputError("Anda tidak boleh meluluskan permohonan sendiri.", 403);
    db.prepare("UPDATE leave_requests SET status = ?, decided_by = ? WHERE id = ?").run(status, req.user.id, row.id);
    audit(db, req.user.id, "keputusan_cuti", { id: row.id, status });
    res.json({ ok: true });
  }));

  // ===== Tuntutan =====
  r.get("/claims", h((req, res) => {
    const all = ["admin", "pengurus", "kewangan"].includes(req.user.role) && req.query.all === "1";
    if (!all) needEmployee(req);
    res.json(db.prepare(`
      SELECT c.*, e.name, u.name AS decided_by_name FROM claims c
      JOIN employees e ON e.id = c.employee_id LEFT JOIN users u ON u.id = c.decided_by
      ${all ? "" : "WHERE c.employee_id = ?"} ORDER BY c.id DESC LIMIT 300`).all(...(all ? [] : [req.user.employee_id])));
  }));

  r.post("/claims", h((req, res) => {
    const empId = needEmployee(req);
    const { lastInsertRowid } = db.prepare(`INSERT INTO claims (employee_id, claim_date, category, description, amount)
      VALUES (?, ?, ?, ?, ?)`).run(
      empId,
      date(req.body.claim_date, "Tarikh"),
      oneOf(req.body.category, "Kategori", CLAIM_CATEGORIES),
      str(req.body.description, "Keterangan", { required: false }),
      round2(num(req.body.amount, "Jumlah", { min: 0.01, max: 1e6 }))
    );
    res.json({ id: Number(lastInsertRowid) });
  }));

  r.post("/claims/:id/decide", requireRole("pengurus"), h((req, res) => {
    const status = oneOf(req.body.status, "Keputusan", ["lulus", "ditolak"]);
    const row = db.prepare("SELECT * FROM claims WHERE id = ?").get(Number(req.params.id));
    if (!row) throw new InputError("Tuntutan tiada.", 404);
    if (row.status !== "menunggu") throw new InputError("Tuntutan ini sudah diputuskan.");
    if (row.employee_id === req.user.employee_id) throw new InputError("Anda tidak boleh meluluskan tuntutan sendiri.", 403);
    db.prepare("UPDATE claims SET status = ?, decided_by = ? WHERE id = ?").run(status, req.user.id, row.id);
    audit(db, req.user.id, "keputusan_tuntutan", { id: row.id, status });
    res.json({ ok: true });
  }));

  // Bayar tuntutan yang telah lulus: Dt Perjalanan & Tuntutan / Kt Tunai di Bank.
  r.post("/claims/:id/pay", requireRole("kewangan"), h((req, res) => {
    const row = db.prepare("SELECT c.*, e.name FROM claims c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?").get(Number(req.params.id));
    if (!row) throw new InputError("Tuntutan tiada.", 404);
    if (row.status !== "lulus") throw new InputError("Hanya tuntutan yang lulus boleh dibayar.");
    tx(db, () => {
      const jid = postJournal(db, {
        date: today(), memo: `Bayaran tuntutan #${row.id} – ${row.name}`, source: "tuntutan", sourceId: row.id, userId: req.user.id,
        lines: [{ code: "5400", debit: row.amount }, { code: "1000", credit: row.amount }],
      });
      db.prepare("UPDATE claims SET status = 'dibayar', journal_id = ? WHERE id = ?").run(jid, row.id);
    });
    audit(db, req.user.id, "bayar_tuntutan", { id: row.id });
    res.json({ ok: true });
  }));

  // ===== Gaji =====
  r.get("/payslips", h((req, res) => {
    const all = ["admin", "kewangan"].includes(req.user.role) && req.query.all === "1";
    if (!all) needEmployee(req);
    res.json(db.prepare(`
      SELECT p.*, e.name, e.position, e.ic_no FROM payslips p JOIN employees e ON e.id = p.employee_id
      ${all ? "" : "WHERE p.employee_id = ?"} ORDER BY p.period DESC, e.name LIMIT 500`).all(...(all ? [] : [req.user.employee_id])));
  }));

  r.get("/payroll/preview", requireRole("kewangan"), h((req, res) => {
    const emps = db.prepare("SELECT id, name, basic_salary FROM employees WHERE active = 1 AND basic_salary > 0 ORDER BY name").all();
    res.json(emps.map((e) => ({ employee_id: e.id, name: e.name, basic: e.basic_salary, ...epfFields(e.basic_salary) })));
  }));
  const epfFields = (wage) => { const x = epf(wage); return { epf_employee: x.employee, epf_employer: x.employer }; };

  // Jana slip gaji untuk satu bulan dan rekod jurnal gaji.
  r.post("/payroll/run", requireRole("kewangan"), h((req, res) => {
    const period = String(req.body.period || "");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new InputError("Tempoh mesti dalam format YYYY-MM.");
    if (db.prepare("SELECT 1 FROM payslips WHERE period = ?").get(period)) throw new InputError(`Gaji untuk ${period} sudah dijana.`);
    const extras = new Map((Array.isArray(req.body.items) ? req.body.items : []).map((i) => [Number(i.employee_id), i]));
    const emps = db.prepare("SELECT id, name, basic_salary FROM employees WHERE active = 1 AND basic_salary > 0").all();
    if (!emps.length) throw new InputError("Tiada pekerja aktif dengan gaji pokok.");

    const result = tx(db, () => {
      let gross = 0, epfEe = 0, epfEr = 0, other = 0, net = 0;
      const ins = db.prepare(`INSERT INTO payslips (employee_id, period, basic, allowances, other_deductions, epf_employee, epf_employer, net_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      const ids = [];
      for (const e of emps) {
        const x = extras.get(e.id) || {};
        const allowances = round2(num(x.allowances ?? 0, "Elaun", { min: 0, max: 1e7 }));
        const ded = round2(num(x.other_deductions ?? 0, "Potongan", { min: 0, max: 1e7 }));
        const wage = round2(e.basic_salary + allowances);
        const k = epf(wage);
        const n = round2(wage - k.employee - ded);
        if (n < 0) throw new InputError(`Gaji bersih ${e.name} menjadi negatif.`);
        ids.push(Number(ins.run(e.id, period, e.basic_salary, allowances, ded, k.employee, k.employer, n).lastInsertRowid));
        gross += wage; epfEe += k.employee; epfEr += k.employer; other += ded; net += n;
      }
      const jid = postJournal(db, {
        date: payrollDate(period), memo: `Gaji ${period}`, source: "gaji", userId: req.user.id,
        lines: [
          { code: "5000", debit: gross },
          { code: "5010", debit: epfEr },
          { code: "2200", credit: epfEe + epfEr },
          { code: "2000", credit: other },
          { code: "1000", credit: net },
        ],
      });
      db.prepare(`UPDATE payslips SET journal_id = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(jid, ...ids);
      return { count: ids.length, gross: round2(gross), net: round2(net), epf: round2(epfEe + epfEr) };
    });
    audit(db, req.user.id, "jana_gaji", { period, ...result });
    res.json(result);
  }));

  return r;
}
