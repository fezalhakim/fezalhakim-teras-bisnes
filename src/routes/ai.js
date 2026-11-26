import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { requireRole } from "../auth.js";
import { round2 } from "../db.js";
import { str, InputError, h, today } from "../util.js";

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

const SYSTEM_PROMPT = `Anda pembantu perniagaan untuk sebuah syarikat kecil di Malaysia.
Anda diberi petikan data syarikat (JSON) yang dibaca dari sistem HR, perakaunan dan CRM.
Peraturan:
- Jawab dalam Bahasa Melayu yang ringkas dan jelas, melainkan pengguna bertanya dalam bahasa lain.
- Gunakan HANYA data yang diberi. Jika data tidak mencukupi untuk menjawab, katakan begitu. Jangan reka angka.
- Sebut bahagian data yang anda guna (cth "dari senarai invois tertunggak").
- Anda hanya boleh membaca. Jika diminta mengubah data, terangkan langkah yang pengguna perlu buat sendiri dalam sistem.
- Mata wang ialah Ringgit Malaysia (RM).`;

// Kumpul petikan data mengikut peranan pengguna. AI tidak pernah menerima kata laluan atau token.
export function buildSnapshot(db, user) {
  const d = today();
  const month = d.slice(0, 7);
  const role = user.role;
  const snap = { tarikh_hari_ini: d, peranan_pengguna: role };

  if (["admin", "pengurus"].includes(role)) {
    snap.hr = {
      pekerja_aktif: db.prepare("SELECT name, position, department, join_date FROM employees WHERE active = 1 ORDER BY name LIMIT 200").all(),
      hadir_hari_ini: db.prepare("SELECT e.name, a.clock_in, a.clock_out FROM attendance a JOIN employees e ON e.id = a.employee_id WHERE a.work_date = ?").all(d),
      cuti_menunggu: db.prepare("SELECT e.name, l.leave_type, l.start_date, l.end_date, l.days FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'menunggu'").all(),
      cuti_lulus_bulan_ini: db.prepare("SELECT e.name, l.leave_type, l.start_date, l.end_date, l.days FROM leave_requests l JOIN employees e ON e.id = l.employee_id WHERE l.status = 'lulus' AND (substr(l.start_date,1,7) = ? OR substr(l.end_date,1,7) = ?)").all(month, month),
      tuntutan_menunggu: db.prepare("SELECT e.name, c.category, c.amount, c.claim_date FROM claims c JOIN employees e ON e.id = c.employee_id WHERE c.status = 'menunggu'").all(),
    };
  }
  if (["admin", "kewangan"].includes(role)) {
    const byType = db.prepare(`
      SELECT substr(j.entry_date,1,7) AS bulan, a.type,
        ROUND(SUM(CASE WHEN a.type = 'hasil' THEN l.credit - l.debit ELSE l.debit - l.credit END), 2) AS jumlah
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN journal_entries j ON j.id = l.entry_id
      WHERE a.type IN ('hasil','belanja') AND j.entry_date >= date(?, '-12 months')
      GROUP BY bulan, a.type ORDER BY bulan`).all(d);
    snap.kewangan = {
      hasil_dan_belanja_12_bulan: byType,
      belanja_ikut_akaun_bulan_ini: db.prepare(`
        SELECT a.name, ROUND(SUM(l.debit - l.credit), 2) AS jumlah FROM journal_lines l
        JOIN accounts a ON a.id = l.account_id JOIN journal_entries j ON j.id = l.entry_id
        WHERE a.type = 'belanja' AND substr(j.entry_date,1,7) = ? GROUP BY a.id ORDER BY jumlah DESC`).all(month),
      baki_tunai_bank: round2(db.prepare("SELECT COALESCE(SUM(l.debit - l.credit),0) AS v FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE a.code = '1000'").get().v),
      invois_tertunggak: db.prepare("SELECT number, customer_name, issue_date, due_date, total, paid, ROUND(total - paid, 2) AS baki FROM invoices WHERE status != 'dibayar' ORDER BY due_date LIMIT 100").all(),
      tuntutan_untuk_dibayar: db.prepare("SELECT e.name, c.amount FROM claims c JOIN employees e ON e.id = c.employee_id WHERE c.status = 'lulus'").all(),
    };
  }
  const own = ["admin", "pengurus"].includes(role) ? "" : ` AND d.owner_id = ${Number(user.id)}`;
  snap.crm = {
    urus_niaga_terbuka: db.prepare(`SELECT d.title, d.value, d.stage, d.expected_close, d.updated_at, c.name AS kenalan, u.name AS pemilik
      FROM deals d LEFT JOIN contacts c ON c.id = d.contact_id LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.stage NOT IN ('menang','kalah')${own} ORDER BY d.value DESC LIMIT 100`).all(),
    menang_kalah_90_hari: db.prepare(`SELECT d.stage, COUNT(*) AS bilangan, ROUND(SUM(d.value),2) AS nilai FROM deals d
      WHERE d.stage IN ('menang','kalah') AND d.updated_at >= date(?, '-90 days')${own} GROUP BY d.stage`).all(d),
    kenalan_baru_ikut_sumber_bulan_ini: db.prepare(`SELECT COALESCE(source,'tiada') AS sumber, COUNT(*) AS bilangan FROM contacts d
      WHERE substr(created_at,1,7) = ?${own} GROUP BY source`).all(month),
  };
  return snap;
}

export default function aiRoutes(db) {
  const r = Router();
  r.use(requireRole("pengurus", "kewangan"));
  let client = null;

  r.get("/status", (req, res) => {
    res.json({ enabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) });
  });

  r.post("/ask", h(async (req, res) => {
    const question = str(req.body.question, "Soalan", { max: 1000 });
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new InputError("Pembantu AI belum diaktifkan. Admin perlu tetapkan ANTHROPIC_API_KEY pada pelayan.", 503);
    }
    client ??= new Anthropic();
    const history = (Array.isArray(req.body.history) ? req.body.history : []).slice(-6)
      .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    // Mesej pertama mesti daripada pengguna.
    while (history.length && history[0].role !== "user") history.shift();
    const snapshot = buildSnapshot(db, req.user);

    try {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: `${SYSTEM_PROMPT}\n\nData syarikat:\n${JSON.stringify(snapshot)}`,
        messages: [...history, { role: "user", content: question }],
      });
      if (response.stop_reason === "refusal") return res.status(422).json({ error: "Soalan ini tidak dapat dijawab." });
      const answer = response.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      res.json({ answer, sources: Object.keys(snapshot).filter((k) => typeof snapshot[k] === "object") });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return res.status(500).json({ error: "ANTHROPIC_API_KEY tidak sah." });
      if (err instanceof Anthropic.RateLimitError) return res.status(429).json({ error: "Terlalu banyak permintaan, cuba sebentar lagi." });
      if (err instanceof Anthropic.APIError) {
        console.error("API error:", err.status, err.message);
        return res.status(502).json({ error: "Ralat dari perkhidmatan AI." });
      }
      throw err;
    }
  }));

  return r;
}
