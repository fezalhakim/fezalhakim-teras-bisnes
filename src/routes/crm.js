import { Router } from "express";
import { requireAuth } from "../auth.js";
import { audit, round2 } from "../db.js";
import { str, num, date, oneOf, InputError, h } from "../util.js";

export const STAGES = ["baru", "dihubungi", "sebut_harga", "rundingan", "menang", "kalah"];

export default function crmRoutes(db) {
  const r = Router();
  r.use(requireAuth);

  // Admin dan pengurus nampak semua; peranan lain hanya nampak rekod milik sendiri.
  const seesAll = (u) => ["admin", "pengurus"].includes(u.role);
  const scope = (req, alias) => (seesAll(req.user) ? { sql: "", args: [] } : { sql: ` AND ${alias}.owner_id = ?`, args: [req.user.id] });
  const canTouch = (req, row) => row && (seesAll(req.user) || row.owner_id === req.user.id);
  const ownerFor = (req) => (seesAll(req.user) && req.body.owner_id ? Number(req.body.owner_id) : req.user.id);

  // ===== Kenalan =====
  r.get("/contacts", (req, res) => {
    const s = scope(req, "c");
    const q = req.query.q ? `%${String(req.query.q).slice(0, 100)}%` : null;
    res.json(db.prepare(`
      SELECT c.*, u.name AS owner_name,
        (SELECT COUNT(*) FROM deals d WHERE d.contact_id = c.id) AS deal_count
      FROM contacts c LEFT JOIN users u ON u.id = c.owner_id
      WHERE 1=1 ${s.sql} ${q ? "AND (c.name LIKE ? OR c.company LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)" : ""}
      ORDER BY c.id DESC LIMIT 500`).all(...s.args, ...(q ? [q, q, q, q] : [])));
  });

  const readContact = (b) => ({
    name: str(b.name, "Nama", { max: 120 }),
    company: str(b.company, "Syarikat", { required: false, max: 120 }),
    phone: str(b.phone, "Telefon", { required: false, max: 30 }),
    email: str(b.email, "E-mel", { required: false, max: 200 }),
    source: str(b.source, "Sumber", { required: false, max: 60 }),
    notes: str(b.notes, "Nota", { required: false, max: 2000 }),
  });

  r.post("/contacts", h((req, res) => {
    const c = readContact(req.body);
    const { lastInsertRowid } = db.prepare(`INSERT INTO contacts (name, company, phone, email, source, notes, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(c.name, c.company, c.phone, c.email, c.source, c.notes, ownerFor(req));
    res.json({ id: Number(lastInsertRowid) });
  }));

  r.get("/contacts/:id", h((req, res) => {
    const c = db.prepare("SELECT c.*, u.name AS owner_name FROM contacts c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?").get(Number(req.params.id));
    if (!canTouch(req, c)) throw new InputError("Kenalan tiada.", 404);
    c.deals = db.prepare("SELECT * FROM deals WHERE contact_id = ? ORDER BY id DESC").all(c.id);
    c.activities = db.prepare("SELECT a.*, u.name AS user_name FROM activities a LEFT JOIN users u ON u.id = a.user_id WHERE a.contact_id = ? ORDER BY a.id DESC LIMIT 100").all(c.id);
    res.json(c);
  }));

  r.put("/contacts/:id", h((req, res) => {
    const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(Number(req.params.id));
    if (!canTouch(req, row)) throw new InputError("Kenalan tiada.", 404);
    const c = readContact(req.body);
    db.prepare("UPDATE contacts SET name=?, company=?, phone=?, email=?, source=?, notes=?, owner_id=? WHERE id=?")
      .run(c.name, c.company, c.phone, c.email, c.source, c.notes, seesAll(req.user) && req.body.owner_id ? Number(req.body.owner_id) : row.owner_id, row.id);
    res.json({ ok: true });
  }));

  r.post("/contacts/:id/activities", h((req, res) => {
    const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(Number(req.params.id));
    if (!canTouch(req, row)) throw new InputError("Kenalan tiada.", 404);
    db.prepare("INSERT INTO activities (contact_id, user_id, kind, note) VALUES (?, ?, ?, ?)").run(
      row.id, req.user.id, oneOf(req.body.kind, "Jenis", ["panggilan", "whatsapp", "emel", "mesyuarat", "nota"]),
      str(req.body.note, "Nota", { max: 2000 }));
    res.json({ ok: true });
  }));

  // ===== Urus niaga (pipeline) =====
  r.get("/deals", (req, res) => {
    const s = scope(req, "d");
    res.json(db.prepare(`
      SELECT d.*, c.name AS contact_name, c.company, u.name AS owner_name
      FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN users u ON u.id = d.owner_id
      WHERE 1=1 ${s.sql} ORDER BY d.updated_at DESC LIMIT 1000`).all(...s.args));
  });

  r.post("/deals", h((req, res) => {
    const contactId = Number(req.body.contact_id) || null;
    if (contactId && !canTouch(req, db.prepare("SELECT * FROM contacts WHERE id = ?").get(contactId))) throw new InputError("Kenalan tiada.");
    const { lastInsertRowid } = db.prepare(`INSERT INTO deals (title, contact_id, value, stage, owner_id, expected_close) VALUES (?, ?, ?, ?, ?, ?)`).run(
      str(req.body.title, "Tajuk", { max: 200 }), contactId,
      round2(num(req.body.value ?? 0, "Nilai", { min: 0, max: 1e10 })),
      oneOf(req.body.stage || "baru", "Peringkat", STAGES), ownerFor(req),
      date(req.body.expected_close, "Jangka tutup", { required: false }));
    res.json({ id: Number(lastInsertRowid) });
  }));

  r.put("/deals/:id", h((req, res) => {
    const row = db.prepare("SELECT * FROM deals WHERE id = ?").get(Number(req.params.id));
    if (!canTouch(req, row)) throw new InputError("Urus niaga tiada.", 404);
    const b = req.body;
    const stage = b.stage != null ? oneOf(b.stage, "Peringkat", STAGES) : row.stage;
    db.prepare(`UPDATE deals SET title=?, value=?, stage=?, expected_close=?, owner_id=?, updated_at=datetime('now') WHERE id=?`).run(
      b.title != null ? str(b.title, "Tajuk", { max: 200 }) : row.title,
      b.value != null ? round2(num(b.value, "Nilai", { min: 0, max: 1e10 })) : row.value,
      stage,
      b.expected_close !== undefined ? date(b.expected_close, "Jangka tutup", { required: false }) : row.expected_close,
      seesAll(req.user) && b.owner_id ? Number(b.owner_id) : row.owner_id,
      row.id);
    if (stage !== row.stage) {
      db.prepare("INSERT INTO activities (contact_id, deal_id, user_id, kind, note) VALUES (?, ?, ?, 'peringkat', ?)")
        .run(row.contact_id, row.id, req.user.id, `${row.title}: ${row.stage} → ${stage}`);
      audit(db, req.user.id, "tukar_peringkat", { id: row.id, from: row.stage, to: stage });
    }
    res.json({ ok: true });
  }));

  // Senarai pengguna untuk pilihan pemilik (nama sahaja).
  r.get("/owners", (req, res) => {
    res.json(db.prepare("SELECT id, name FROM users WHERE active = 1 ORDER BY name").all());
  });

  return r;
}

// Borang lead awam: boleh dibenamkan di laman web syarikat. Tiada log masuk diperlukan.
export function publicLeadRoute(db) {
  const hits = new Map();
  return h((req, res) => {
    const now = Date.now();
    const rec = hits.get(req.ip) || [];
    const recent = rec.filter((t) => now - t < 60 * 60e3);
    if (recent.length >= 20) throw new InputError("Terlalu banyak penghantaran. Cuba lagi kemudian.", 429);
    recent.push(now);
    hits.set(req.ip, recent);
    if (req.body.website) return res.json({ ok: true }); // perangkap bot (honeypot)
    const name = str(req.body.name, "Nama", { max: 120 });
    const phone = str(req.body.phone, "Telefon", { required: false, max: 30 });
    const email = str(req.body.email, "E-mel", { required: false, max: 200 });
    if (!phone && !email) throw new InputError("Sila isi telefon atau e-mel.");
    const message = str(req.body.message, "Mesej", { required: false, max: 2000 });
    const owner = db.prepare("SELECT id FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get()?.id ?? null;
    const cid = Number(db.prepare("INSERT INTO contacts (name, phone, email, source, notes, owner_id) VALUES (?, ?, ?, 'borang_web', ?, ?)")
      .run(name, phone, email, message, owner).lastInsertRowid);
    db.prepare("INSERT INTO deals (title, contact_id, stage, owner_id) VALUES (?, ?, 'baru', ?)").run(`Lead web – ${name}`, cid, owner);
    res.json({ ok: true });
  });
}
