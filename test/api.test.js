import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { createApp } from "../server.js";
import { epf, payrollDate } from "../src/routes/hr.js";

let server, base, db;

before(async () => {
  db = openDb(":memory:");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

// Klien ringkas yang menyimpan kuki sesi.
function client() {
  let cookie = "";
  return async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method || (body ? "POST" : "GET"),
      headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) cookie = sc.split(";")[0];
    return { status: res.status, data: await res.json() };
  };
}

const admin = client(), staff = client(), fin = client(), mgr = client();

test("persediaan admin pertama, dan hanya sekali", async () => {
  let r = await admin("/status");
  assert.equal(r.data.needsSetup, true);
  r = await admin("/setup", { company: "Ujian Sdn Bhd", name: "Ali", email: "ali@ujian.my", password: "rahsia123" });
  assert.equal(r.status, 200);
  r = await client()("/setup", { company: "X", name: "Y", email: "y@y.my", password: "rahsia123" });
  assert.equal(r.status, 409);
  r = await admin("/status");
  assert.equal(r.data.user.role, "admin");
});

test("perlu log masuk & CSRF: bukan JSON ditolak", async () => {
  assert.equal((await client()("/dashboard")).status, 401);
  const res = await fetch(base + "/login", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=a" });
  assert.equal(res.status, 415);
});

test("cipta pekerja + pengguna dengan peranan", async () => {
  let r = await admin("/hr/employees", { name: "Siti", basic_salary: 3000, annual_leave_days: 14 });
  const sitiEmp = r.data.id;
  r = await admin("/hr/employees", { name: "Ahmad", basic_salary: 6000 });
  const ahmadEmp = r.data.id;
  assert.equal((await admin("/users", { name: "Siti", email: "siti@ujian.my", password: "rahsia123", role: "pekerja", employee_id: sitiEmp })).status, 200);
  assert.equal((await admin("/users", { name: "Ahmad", email: "ahmad@ujian.my", password: "rahsia123", role: "kewangan", employee_id: ahmadEmp })).status, 200);
  assert.equal((await admin("/users", { name: "Mira", email: "mira@ujian.my", password: "rahsia123", role: "pengurus" })).status, 200);
  assert.equal((await staff("/login", { email: "siti@ujian.my", password: "salah" })).status, 401);
  assert.equal((await staff("/login", { email: "siti@ujian.my", password: "rahsia123" })).status, 200);
  assert.equal((await fin("/login", { email: "ahmad@ujian.my", password: "rahsia123" })).status, 200);
  assert.equal((await mgr("/login", { email: "mira@ujian.my", password: "rahsia123" })).status, 200);
});

test("pekerja tidak boleh akses kewangan atau senarai pekerja", async () => {
  assert.equal((await staff("/finance/invoices")).status, 403);
  assert.equal((await staff("/hr/employees")).status, 403);
  assert.equal((await staff("/users")).status, 403);
  assert.equal((await staff("/ai/status")).status, 403);
});

test("clock-in, clock-out, kemudian ditolak", async () => {
  assert.equal((await staff("/hr/clock", { lat: 3.139, lng: 101.6869 })).data.action, "masuk");
  assert.equal((await staff("/hr/clock", {})).data.action, "keluar");
  assert.equal((await staff("/hr/clock", {})).status, 400);
});

test("cuti: baki disemak, pertindihan ditolak, pengurus lulus", async () => {
  let r = await staff("/hr/leave", { leave_type: "tahunan", start_date: "2026-12-01", end_date: "2026-12-30" });
  assert.equal(r.status, 400, "melebihi baki 14 hari");
  r = await staff("/hr/leave", { leave_type: "tahunan", start_date: "2026-12-01", end_date: "2026-12-03" });
  assert.equal(r.status, 200);
  const id = r.data.id;
  assert.equal((await staff("/hr/leave", { leave_type: "sakit", start_date: "2026-12-02", end_date: "2026-12-02" })).status, 400);
  assert.equal((await staff(`/hr/leave/${id}/decide`, { status: "lulus" })).status, 403);
  assert.equal((await mgr(`/hr/leave/${id}/decide`, { status: "lulus" })).status, 200);
  assert.equal((await mgr(`/hr/leave/${id}/decide`, { status: "ditolak" })).status, 400);
  r = await staff("/hr/me");
  assert.equal(r.data.leave.balance, 11);
});

test("tuntutan: lulus oleh pengurus, bayar oleh kewangan -> jurnal", async () => {
  let r = await staff("/hr/claims", { claim_date: "2026-11-20", category: "minyak", amount: 85.5 });
  const id = r.data.id;
  assert.equal((await fin(`/hr/claims/${id}/pay`, {})).status, 400, "belum lulus");
  assert.equal((await mgr(`/hr/claims/${id}/decide`, { status: "lulus" })).status, 200);
  assert.equal((await fin(`/hr/claims/${id}/pay`, {})).status, 200);
});

test("invois dengan SST, bayaran separa & penuh", async () => {
  let r = await fin("/finance/invoices", {
    customer_name: "Pelanggan A", issue_date: "2026-11-10", due_date: "2026-11-20",
    lines: [{ description: "Khidmat reka bentuk", qty: 2, unit_price: 500, sst_rate: 8 }, { description: "Cetak", qty: 1, unit_price: 100, sst_rate: 0 }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.number, "INV-2026-0001");
  assert.equal(r.data.total, 1180);
  const id = r.data.id;
  assert.equal((await fin(`/finance/invoices/${id}/payments`, { amount: 2000 })).status, 400);
  assert.equal((await fin(`/finance/invoices/${id}/payments`, { amount: 500 })).status, 200);
  assert.equal((await fin(`/finance/invoices/${id}`)).data.status, "separa");
  assert.equal((await fin(`/finance/invoices/${id}/payments`, { amount: 680 })).status, 200);
  assert.equal((await fin(`/finance/invoices/${id}`)).data.status, "dibayar");
  r = await fin("/finance/reports/sst?from=2026-11-01&to=2026-11-30");
  assert.deepEqual(r.data.rows.find((x) => x.sst_rate === 8), { sst_rate: 8, taxable: 1000, sst: 80 });
});

test("belanja + gaji + laporan seimbang", async () => {
  const accs = (await fin("/finance/accounts")).data;
  const rent = accs.find((a) => a.code === "5100");
  assert.equal((await fin("/finance/expenses", { expense_date: "2026-11-05", vendor: "Tuan rumah", account_id: rent.id, amount: 1500 })).status, 200);
  assert.equal((await fin("/finance/expenses", { vendor: "X", account_id: accs.find((a) => a.code === "1000").id, amount: 10 })).status, 400, "bukan akaun belanja");

  let r = await fin("/hr/payroll/run", { period: "2026-11", items: [] });
  assert.equal(r.status, 200);
  // Ali (admin) tiada gaji pokok, jadi hanya Siti dan Ahmad.
  assert.equal(r.data.count, 2);
  assert.equal((await fin("/hr/payroll/run", { period: "2026-11" })).status, 400, "tidak boleh jana dua kali");

  const tb = (await fin("/finance/reports/trial-balance?to=2026-12-31")).data;
  assert.equal(tb.totalDr, tb.totalCr);
  const bs = (await fin("/finance/reports/balance-sheet?to=2026-12-31")).data;
  assert.ok(Math.abs(bs.totalAssets - bs.totalLiabilities - bs.totalEquity) < 0.005);
  const pl = (await fin("/finance/reports/profit-loss?from=2026-11-01&to=2026-11-30")).data;
  assert.equal(pl.totalRevenue, 1100);

  const slips = (await staff("/hr/payslips")).data;
  assert.equal(slips.length, 1, "pekerja hanya nampak slip sendiri");
  assert.equal(slips[0].epf_employee, 330);
  assert.equal(slips[0].net_pay, 2670);
});

test("jurnal tidak boleh diubah atau dipadam", () => {
  assert.throws(() => db.prepare("UPDATE journal_lines SET debit = 1").run(), /tidak boleh diubah/);
  assert.throws(() => db.prepare("DELETE FROM journal_entries").run(), /tidak boleh dipadam/);
});

test("jurnal manual tidak seimbang ditolak", async () => {
  const accs = (await fin("/finance/accounts")).data;
  const r = await fin("/finance/journal", { memo: "Modal", lines: [
    { account_id: accs.find((a) => a.code === "1000").id, debit: 10000 },
    { account_id: accs.find((a) => a.code === "3000").id, credit: 9000 }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /tidak seimbang/);
});

test("CRM: pekerja hanya nampak rekod sendiri; pengurus nampak semua", async () => {
  const c = (await staff("/crm/contacts", { name: "Encik Lim", phone: "0123456789" })).data.id;
  await staff("/crm/deals", { title: "Projek Lim", contact_id: c, value: 5000 });
  await admin("/crm/contacts", { name: "Puan Tan" });
  assert.equal((await staff("/crm/contacts")).data.length, 1);
  assert.equal((await mgr("/crm/contacts")).data.length, 2);
  const adminContact = (await admin("/crm/contacts")).data.find((x) => x.name === "Puan Tan");
  assert.equal((await staff(`/crm/contacts/${adminContact.id}`)).status, 404);
  const deal = (await staff("/crm/deals")).data[0];
  assert.equal((await staff(`/crm/deals/${deal.id}`, { stage: "menang" }, "PUT")).status, 200);
  assert.equal((await staff("/dashboard")).data.crm.wonMonth.n, 1);
});

test("borang lead awam cipta kenalan + urus niaga", async () => {
  const res = await fetch(base + "/public/lead", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Pengunjung", email: "p@x.my" }) });
  assert.equal(res.status, 200);
  const contacts = (await admin("/crm/contacts")).data;
  assert.ok(contacts.some((c) => c.name === "Pengunjung" && c.source === "borang_web"));
});

test("tukar peranan berkesan serta-merta; nyahaktif tamatkan sesi", async () => {
  const users = (await admin("/users")).data;
  const siti = users.find((u) => u.email === "siti@ujian.my");
  await admin(`/users/${siti.id}`, { role: "kewangan" }, "PUT");
  assert.equal((await staff("/finance/invoices")).status, 200);
  await admin(`/users/${siti.id}`, { active: false }, "PUT");
  assert.equal((await staff("/dashboard")).status, 401);
  const me = users.find((u) => u.email === "ali@ujian.my");
  assert.equal((await admin(`/users/${me.id}`, { role: "pekerja" }, "PUT")).status, 400);
});

test("AI: snapshot ikut peranan & tanpa kunci API", async () => {
  const { buildSnapshot } = await import("../src/routes/ai.js");
  const pekerja = buildSnapshot(db, { id: 999, role: "pekerja" });
  assert.equal(pekerja.kewangan, undefined);
  assert.equal(pekerja.hr, undefined);
  const k = buildSnapshot(db, { id: 1, role: "kewangan" });
  assert.ok(k.kewangan.invois_tertunggak);
  if (!process.env.ANTHROPIC_API_KEY) {
    assert.equal((await mgr("/ai/ask", { question: "Hai" })).status, 503);
  }
});

test("tarikh jurnal gaji tidak melepasi hari ini", () => {
  assert.equal(payrollDate("2026-11", "2026-11-26"), "2026-11-26");
  assert.equal(payrollDate("2026-10", "2026-11-26"), "2026-10-31");
  assert.equal(payrollDate("2028-02", "2028-03-01"), "2028-02-29");
});

test("kadar KWSP", () => {
  assert.deepEqual(epf(3000), { employee: 330, employer: 390 });
  assert.deepEqual(epf(6000), { employee: 660, employer: 720 });
});
