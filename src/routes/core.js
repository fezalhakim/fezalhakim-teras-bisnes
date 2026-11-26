import { Router } from "express";
import { hashPassword, verifyPassword, validatePassword, createSession, COOKIE, cookieOptions, requireAuth, requireRole, loginLimiter } from "../auth.js";
import { audit, round2 } from "../db.js";
import { str, oneOf, InputError, h, today } from "../util.js";

const ROLES = ["admin", "pengurus", "kewangan", "pekerja"];

export default function coreRoutes(db) {
  const r = Router();

  const userCount = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const getSetting = (k, d = "") => db.prepare("SELECT value FROM settings WHERE key = ?").get(k)?.value ?? d;

  r.get("/status", (req, res) => {
    res.json({
      needsSetup: userCount() === 0,
      company: getSetting("company_name", "Syarikat Saya"),
      user: req.user,
    });
  });

  // Persediaan kali pertama: cipta admin pertama dan nama syarikat.
  r.post("/setup", h((req, res) => {
    if (userCount() > 0) throw new InputError("Sistem sudah disediakan.", 409);
    const company = str(req.body.company, "Nama syarikat", { max: 120 });
    const name = str(req.body.name, "Nama", { max: 120 });
    const email = str(req.body.email, "E-mel", { max: 200 });
    const pwErr = validatePassword(req.body.password);
    if (pwErr) throw new InputError(pwErr);
    const { lastInsertRowid } = db
      .prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, 'admin', ?)")
      .run(email, name, hashPassword(req.body.password));
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_name', ?)").run(company);
    db.prepare("INSERT INTO employees (user_id, name, position, join_date) VALUES (?, ?, 'Pengasas', ?)").run(lastInsertRowid, name, today());
    audit(db, lastInsertRowid, "setup", { company });
    const s = createSession(db, lastInsertRowid);
    res.cookie(COOKIE, s.token, { ...cookieOptions(req), maxAge: s.maxAge });
    res.json({ ok: true });
  }));

  r.post("/login", loginLimiter, h((req, res) => {
    const email = String(req.body.email || "").trim();
    const user = db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(email);
    if (!user || !verifyPassword(String(req.body.password || ""), user.password_hash)) {
      throw new InputError("E-mel atau kata laluan salah.", 401);
    }
    const s = createSession(db, user.id);
    res.cookie(COOKIE, s.token, { ...cookieOptions(req), maxAge: s.maxAge });
    audit(db, user.id, "log_masuk");
    res.json({ ok: true });
  }));

  r.post("/logout", (req, res) => {
    if (req.sessionToken) db.prepare("DELETE FROM sessions WHERE token = ?").run(req.sessionToken);
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ ok: true });
  });

  r.post("/me/password", requireAuth, h((req, res) => {
    const u = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
    if (!verifyPassword(String(req.body.current || ""), u.password_hash)) throw new InputError("Kata laluan semasa salah.");
    const pwErr = validatePassword(req.body.password);
    if (pwErr) throw new InputError(pwErr);
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(req.body.password), req.user.id);
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?").run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  }));

  // ===== Pengurusan pengguna (admin) =====
  r.get("/users", requireRole(), (req, res) => {
    res.json(db.prepare(`
      SELECT u.id, u.email, u.name, u.role, u.active, e.id AS employee_id
      FROM users u LEFT JOIN employees e ON e.user_id = u.id ORDER BY u.name`).all());
  });

  r.post("/users", requireRole(), h((req, res) => {
    const email = str(req.body.email, "E-mel", { max: 200 });
    const name = str(req.body.name, "Nama", { max: 120 });
    const role = oneOf(req.body.role, "Peranan", ROLES);
    const pwErr = validatePassword(req.body.password);
    if (pwErr) throw new InputError(pwErr);
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) throw new InputError("E-mel sudah digunakan.");
    const { lastInsertRowid } = db
      .prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?, ?, ?, ?)")
      .run(email, name, role, hashPassword(req.body.password));
    const empId = Number(req.body.employee_id) || null;
    if (empId) db.prepare("UPDATE employees SET user_id = ? WHERE id = ? AND user_id IS NULL").run(lastInsertRowid, empId);
    audit(db, req.user.id, "cipta_pengguna", { email, role });
    res.json({ id: Number(lastInsertRowid) });
  }));

  r.put("/users/:id", requireRole(), h((req, res) => {
    const id = Number(req.params.id);
    const target = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
    if (!target) throw new InputError("Pengguna tiada.", 404);
    const role = req.body.role != null ? oneOf(req.body.role, "Peranan", ROLES) : target.role;
    const active = req.body.active != null ? (req.body.active ? 1 : 0) : target.active;
    if (id === req.user.id && (role !== "admin" || !active)) {
      throw new InputError("Anda tidak boleh membuang akses admin anda sendiri.");
    }
    db.prepare("UPDATE users SET role = ?, active = ? WHERE id = ?").run(role, active, id);
    if (!active) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    if (req.body.password) {
      const pwErr = validatePassword(req.body.password);
      if (pwErr) throw new InputError(pwErr);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(req.body.password), id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
    }
    audit(db, req.user.id, "kemas_kini_pengguna", { id, role, active });
    res.json({ ok: true });
  }));

  r.put("/settings", requireRole(), h((req, res) => {
    const company = str(req.body.company, "Nama syarikat", { max: 120 });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('company_name', ?)").run(company);
    res.json({ ok: true });
  }));

  r.get("/audit", requireRole(), (req, res) => {
    res.json(db.prepare(`
      SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC LIMIT 200`).all());
  });

  // ===== Papan pemuka =====
  r.get("/dashboard", requireAuth, (req, res) => {
    const role = req.user.role;
    const d = today();
    const month = d.slice(0, 7);
    const out = { role };

    if (req.user.employee_id) {
      out.me = {
        attendance: db.prepare("SELECT clock_in, clock_out FROM attendance WHERE employee_id = ? AND work_date = ?").get(req.user.employee_id, d) ?? null,
        pendingLeave: db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE employee_id = ? AND status = 'menunggu'").get(req.user.employee_id).n,
        pendingClaims: db.prepare("SELECT COUNT(*) AS n FROM claims WHERE employee_id = ? AND status = 'menunggu'").get(req.user.employee_id).n,
      };
    }
    if (["admin", "pengurus"].includes(role)) {
      out.hr = {
        employees: db.prepare("SELECT COUNT(*) AS n FROM employees WHERE active = 1").get().n,
        presentToday: db.prepare("SELECT COUNT(*) AS n FROM attendance WHERE work_date = ? AND clock_in IS NOT NULL").get(d).n,
        leaveToApprove: db.prepare("SELECT COUNT(*) AS n FROM leave_requests WHERE status = 'menunggu'").get().n,
        claimsToApprove: db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status = 'menunggu'").get().n,
      };
    }
    if (["admin", "kewangan"].includes(role)) {
      const sumType = (type, sign) => db.prepare(`
        SELECT COALESCE(SUM(${sign}), 0) AS v FROM journal_lines l
        JOIN accounts a ON a.id = l.account_id JOIN journal_entries j ON j.id = l.entry_id
        WHERE a.type = ? AND substr(j.entry_date, 1, 7) = ?`).get(type, month).v;
      out.finance = {
        revenueMonth: round2(sumType("hasil", "l.credit - l.debit")),
        expenseMonth: round2(sumType("belanja", "l.debit - l.credit")),
        receivable: round2(db.prepare("SELECT COALESCE(SUM(total - paid), 0) AS v FROM invoices WHERE status != 'dibayar'").get().v),
        overdue: db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status != 'dibayar' AND due_date < ?").get(d).n,
        claimsToPay: db.prepare("SELECT COUNT(*) AS n FROM claims WHERE status = 'lulus'").get().n,
      };
    }
    const ownerFilter = ["admin", "pengurus"].includes(role) ? "" : " AND owner_id = " + Number(req.user.id);
    out.crm = {
      openDeals: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM deals WHERE stage NOT IN ('menang','kalah')${ownerFilter}`).get(),
      wonMonth: db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM deals WHERE stage = 'menang' AND substr(updated_at, 1, 7) = ?${ownerFilter}`).get(month),
      newContactsMonth: db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE substr(created_at, 1, 7) = ?${ownerFilter}`).get(month).n,
    };
    res.json(out);
  });

  return r;
}
