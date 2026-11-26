// ===== Utiliti =====
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const rm = (n) => "RM " + Number(n || 0).toLocaleString("ms-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString("ms-MY", { hour: "2-digit", minute: "2-digit" }) : "—");
const formData = (form) => Object.fromEntries(new FormData(form));

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: opts.body ? { "Content-Type": "application/json" } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/login")) { state.user = null; renderShell(); throw new Error(data.error || "Sila log masuk."); }
  if (!res.ok) throw new Error(data.error || `Ralat ${res.status}`);
  return data;
}

function toast(msg, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 5000 : 2500);
}

// Hantar borang ke API, papar ralat, dan muat semula paparan jika berjaya.
function onSubmit(form, fn) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit], button:not([type])");
    if (btn) btn.disabled = true;
    try { await fn(formData(form), form); } catch (err) { toast(err.message, true); } finally { if (btn) btn.disabled = false; }
  });
}
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await route(); } catch (err) { toast(err.message, true); }
}

const chip = (status) => {
  const cls = { lulus: "ok", dibayar: "ok", menang: "ok", menunggu: "warn", separa: "warn", belum_bayar: "warn", ditolak: "bad", kalah: "bad" }[status] || "";
  return `<span class="chip ${cls}">${esc(String(status).replace(/_/g, " "))}</span>`;
};
const table = (headers, rows, empty = "Tiada rekod.") =>
  `<div class="table-wrap"><table><thead><tr>${headers.map((h) => `<th class="${h.endsWith("(RM)") || h === "Hari" ? "num" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
  <tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}" class="muted">${empty}</td></tr>`}</tbody></table></div>`;

// ===== Keadaan & navigasi =====
const state = { status: null, user: null };
const ROLE_LABEL = { admin: "Admin", pengurus: "Pengurus", kewangan: "Kewangan", pekerja: "Pekerja" };
const can = (...roles) => state.user && (state.user.role === "admin" || roles.includes(state.user.role));

const NAV = [
  { group: "Umum" },
  { path: "utama", label: "Papan Pemuka", show: () => true },
  { path: "saya", label: "Ruang Saya", show: () => Boolean(state.user.employee_id) },
  { group: "HR" },
  { path: "pekerja", label: "Pekerja", show: () => can("pengurus", "kewangan") },
  { path: "kelulusan", label: "Kelulusan", show: () => can("pengurus") },
  { path: "kehadiran", label: "Kehadiran", show: () => can("pengurus") },
  { path: "gaji", label: "Gaji", show: () => can("kewangan") },
  { group: "Kewangan" },
  { path: "invois", label: "Invois", show: () => can("kewangan") },
  { path: "belanja", label: "Perbelanjaan", show: () => can("kewangan") },
  { path: "tuntutan-bayar", label: "Bayar Tuntutan", show: () => can("kewangan") },
  { path: "jurnal", label: "Jurnal & Akaun", show: () => can("kewangan") },
  { path: "laporan", label: "Laporan", show: () => can("kewangan") },
  { group: "Jualan (CRM)" },
  { path: "pipeline", label: "Pipeline", show: () => true },
  { path: "kenalan", label: "Kenalan", show: () => true },
  { group: "AI" },
  { path: "ai", label: "Tanya AI", show: () => can("pengurus", "kewangan") },
  { group: "Sistem" },
  { path: "tetapan", label: "Tetapan", show: () => can() },
  { path: "akaun", label: "Akaun Saya", show: () => true },
];

async function boot() {
  try {
    state.status = await api("/status");
    state.user = state.status.user;
  } catch (err) {
    $("#app").innerHTML = `<p style="padding:2rem">Tidak dapat menghubungi pelayan: ${esc(err.message)}</p>`;
    return;
  }
  renderShell();
}

function renderShell() {
  const app = $("#app");
  if (state.status.needsSetup) return renderSetup(app);
  if (!state.user) return renderLogin(app);
  const links = [];
  let pendingGroup = null;
  for (const n of NAV) {
    if (n.group) { pendingGroup = n.group; continue; }
    if (!n.show()) continue;
    if (pendingGroup) { links.push(`<div class="group">${esc(pendingGroup)}</div>`); pendingGroup = null; }
    links.push(`<a href="#/${n.path}" data-path="${n.path}">${esc(n.label)}</a>`);
  }
  app.innerHTML = `
    <div class="topbar"><button id="menuBtn" aria-label="Menu">☰</button><strong>${esc(state.status.company)}</strong></div>
    <div class="layout">
      <nav class="side" id="side">
        <div class="brand">${esc(state.status.company)}<small>${esc(state.user.name)} · ${ROLE_LABEL[state.user.role]}</small></div>
        ${links.join("")}
        <div class="group"></div>
        <a href="#" id="logout">Log keluar</a>
      </nav>
      <main id="main"></main>
    </div>`;
  $("#menuBtn").onclick = () => $("#side").classList.toggle("open");
  $("#logout").onclick = async (e) => { e.preventDefault(); await api("/logout", { body: {} }); state.user = null; location.hash = ""; renderShell(); };
  route();
}

function renderSetup(app) {
  app.innerHTML = `<div class="auth"><div class="panel">
    <h1>Selamat datang 👋</h1><p class="muted">Sediakan sistem untuk syarikat anda. Akaun ini akan menjadi admin.</p>
    <form id="f">
      <label>Nama syarikat <input name="company" required></label>
      <label>Nama anda <input name="name" required></label>
      <label>E-mel <input name="email" type="email" required></label>
      <label>Kata laluan (min 8 aksara) <input name="password" type="password" minlength="8" required></label>
      <button class="primary">Mula</button>
    </form></div></div>`;
  onSubmit($("#f"), async (d) => { await api("/setup", { body: d }); await boot(); });
}

function renderLogin(app) {
  app.innerHTML = `<div class="auth"><div class="panel">
    <h1>${esc(state.status.company)}</h1><p class="muted">Log masuk untuk teruskan.</p>
    <form id="f">
      <label>E-mel <input name="email" type="email" autocomplete="username" required></label>
      <label>Kata laluan <input name="password" type="password" autocomplete="current-password" required></label>
      <button class="primary">Log masuk</button>
    </form></div></div>`;
  onSubmit($("#f"), async (d) => { await api("/login", { body: d }); await boot(); });
}

async function route() {
  const main = $("#main");
  if (!main) return;
  const [path, ...rest] = (location.hash.replace(/^#\/?/, "").split("?")[0] || "utama").split("/");
  const nav = NAV.find((n) => n.path === path && !n.group);
  $$("nav.side a").forEach((a) => a.classList.toggle("active", a.dataset.path === path));
  $("#side")?.classList.remove("open");
  const view = VIEWS[path];
  if (!view || (nav && !nav.show())) { main.innerHTML = `<h1>Tidak dijumpai</h1><p class="muted">Halaman ini tiada atau anda tiada akses.</p>`; return; }
  try { await view(main, rest); } catch (err) { main.innerHTML = `<h1>Ralat</h1><p>${esc(err.message)}</p>`; }
}
window.addEventListener("hashchange", route);

// ===== Paparan =====
const VIEWS = {};

VIEWS.utama = async (main) => {
  const d = await api("/dashboard");
  const card = (k, v, href) => `<a class="card" style="text-decoration:none;color:inherit" ${href ? `href="#/${href}"` : ""}><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></a>`;
  let html = `<h1>Papan Pemuka</h1>`;
  if (d.me) {
    const a = d.me.attendance;
    html += `<h2>Saya</h2><div class="cards">
      ${card("Kehadiran hari ini", a ? (a.clock_out ? `${time(a.clock_in)} – ${time(a.clock_out)}` : `Masuk ${time(a.clock_in)}`) : "Belum clock-in", "saya")}
      ${card("Cuti menunggu", d.me.pendingLeave, "saya")}
      ${card("Tuntutan menunggu", d.me.pendingClaims, "saya")}</div>`;
  }
  if (d.hr) html += `<h2>HR</h2><div class="cards">
      ${card("Pekerja aktif", d.hr.employees, "pekerja")}
      ${card("Hadir hari ini", d.hr.presentToday, "kehadiran")}
      ${card("Cuti perlu kelulusan", d.hr.leaveToApprove, "kelulusan")}
      ${card("Tuntutan perlu kelulusan", d.hr.claimsToApprove, "kelulusan")}</div>`;
  if (d.finance) html += `<h2>Kewangan (bulan ini)</h2><div class="cards">
      ${card("Hasil", rm(d.finance.revenueMonth), "laporan")}
      ${card("Belanja", rm(d.finance.expenseMonth), "laporan")}
      ${card("Untung kasar", rm(d.finance.revenueMonth - d.finance.expenseMonth), "laporan")}
      ${card("Belum terima", rm(d.finance.receivable), "invois")}
      ${card("Invois lewat", d.finance.overdue, "invois")}
      ${card("Tuntutan untuk dibayar", d.finance.claimsToPay, "tuntutan-bayar")}</div>`;
  html += `<h2>Jualan</h2><div class="cards">
      ${card("Urus niaga terbuka", `${d.crm.openDeals.n} · ${rm(d.crm.openDeals.v)}`, "pipeline")}
      ${card("Menang bulan ini", `${d.crm.wonMonth.n} · ${rm(d.crm.wonMonth.v)}`, "pipeline")}
      ${card("Kenalan baru bulan ini", d.crm.newContactsMonth, "kenalan")}</div>`;
  main.innerHTML = html;
};

// ----- Ruang Saya (layan diri pekerja) -----
VIEWS.saya = async (main) => {
  const [me, leave, claims, slips] = await Promise.all([api("/hr/me"), api("/hr/leave"), api("/hr/claims"), api("/hr/payslips")]);
  const t = me.today;
  const clockLabel = !t ? "Clock-in" : !t.clock_out ? "Clock-out" : null;
  main.innerHTML = `
    <h1>Ruang Saya</h1>
    <div class="cards">
      <div class="card"><div class="k">Kehadiran hari ini</div>
        <div class="clock" id="clock"></div>
        <div class="muted">Masuk ${time(t?.clock_in)} · Keluar ${time(t?.clock_out)}</div>
        ${clockLabel ? `<button class="primary" id="clockBtn" style="margin-top:.6rem">${clockLabel}</button>` : `<p class="muted">Selesai untuk hari ini ✔</p>`}
      </div>
      <div class="card"><div class="k">Baki cuti tahunan ${todayStr().slice(0, 4)}</div><div class="v">${me.leave.balance} hari</div>
        <div class="muted">Layak ${me.leave.entitled} · Guna/mohon ${me.leave.used}</div></div>
    </div>

    <h2>Mohon cuti</h2>
    <div class="panel"><form class="grid" id="leaveForm">
      <label>Jenis <select name="leave_type"><option value="tahunan">Tahunan</option><option value="sakit">Sakit</option><option value="kecemasan">Kecemasan</option><option value="tanpa_gaji">Tanpa gaji</option><option value="lain">Lain-lain</option></select></label>
      <label>Dari <input type="date" name="start_date" required></label>
      <label>Hingga <input type="date" name="end_date" required></label>
      <label>Sebab <input name="reason"></label>
      <label style="flex-direction:row;align-items:center;gap:.4rem"><input type="checkbox" name="half_day" style="width:auto"> Separuh hari</label>
      <button class="primary">Hantar</button>
    </form></div>
    ${table(["Jenis", "Dari", "Hingga", "Hari", "Status", "Diputuskan oleh"], leave.map((l) =>
      `<tr><td>${esc(l.leave_type)}</td><td>${esc(l.start_date)}</td><td>${esc(l.end_date)}</td><td class="num">${l.days}</td><td>${chip(l.status)}</td><td>${esc(l.decided_by_name || "—")}</td></tr>`))}

    <h2>Hantar tuntutan</h2>
    <div class="panel"><form class="grid" id="claimForm">
      <label>Tarikh <input type="date" name="claim_date" value="${todayStr()}" required></label>
      <label>Kategori <select name="category"><option>perjalanan</option><option>makan</option><option>minyak</option><option>parking</option><option>peralatan</option><option>lain</option></select></label>
      <label>Jumlah (RM) <input type="number" step="0.01" min="0.01" name="amount" required></label>
      <label>Keterangan <input name="description"></label>
      <button class="primary">Hantar</button>
    </form></div>
    ${table(["Tarikh", "Kategori", "Keterangan", "Jumlah (RM)", "Status"], claims.map((c) =>
      `<tr><td>${esc(c.claim_date)}</td><td>${esc(c.category)}</td><td>${esc(c.description)}</td><td class="num">${rm(c.amount)}</td><td>${chip(c.status)}</td></tr>`))}

    <h2>Slip gaji</h2>
    ${table(["Bulan", "Gaji kasar (RM)", "KWSP pekerja (RM)", "Bersih (RM)", ""], slips.map((p) =>
      `<tr><td>${esc(p.period)}</td><td class="num">${rm(p.basic + p.allowances)}</td><td class="num">${rm(p.epf_employee)}</td><td class="num">${rm(p.net_pay)}</td><td><a href="#/slip/${p.id}">Lihat</a></td></tr>`))}`;

  const tick = () => { const c = $("#clock"); if (c) c.textContent = new Date().toLocaleTimeString("ms-MY"); };
  tick(); const iv = setInterval(() => { if (!$("#clock")) clearInterval(iv); else tick(); }, 1000);

  $("#clockBtn")?.addEventListener("click", async (e) => {
    e.target.disabled = true;
    const pos = await new Promise((resolve) => {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition((p) => resolve(p.coords), () => resolve(null), { timeout: 8000 });
    });
    act(() => api("/hr/clock", { body: pos ? { lat: pos.latitude, lng: pos.longitude } : {} }), pos ? "Direkod bersama lokasi" : "Direkod (tanpa lokasi)");
  });
  onSubmit($("#leaveForm"), (d) => act(() => api("/hr/leave", { body: { ...d, half_day: Boolean(d.half_day) } }), "Permohonan dihantar"));
  onSubmit($("#claimForm"), (d) => act(() => api("/hr/claims", { body: d }), "Tuntutan dihantar"));
};

VIEWS.slip = async (main, [id]) => {
  const all = await api(can("kewangan") ? "/hr/payslips?all=1" : "/hr/payslips");
  const p = all.find((x) => String(x.id) === id);
  if (!p) throw new Error("Slip tiada.");
  const row = (k, v) => `<tr><td>${esc(k)}</td><td class="num">${rm(v)}</td></tr>`;
  main.innerHTML = `<div class="panel" style="max-width:520px">
    <div class="row"><h1 style="margin:0">Slip Gaji ${esc(p.period)}</h1><span class="spacer"></span><button class="no-print" onclick="print()">Cetak</button></div>
    <p><strong>${esc(state.status.company)}</strong><br>${esc(p.name)} · ${esc(p.position || "")}${p.ic_no ? ` · ${esc(p.ic_no)}` : ""}</p>
    <table>${row("Gaji pokok", p.basic)}${row("Elaun", p.allowances)}
      <tr class="total"><td>Gaji kasar</td><td class="num">${rm(p.basic + p.allowances)}</td></tr>
      ${row("KWSP pekerja", -p.epf_employee)}${row("Potongan lain", -p.other_deductions)}
      <tr class="total"><td>Gaji bersih</td><td class="num">${rm(p.net_pay)}</td></tr>
      <tr><td class="muted">KWSP majikan</td><td class="num muted">${rm(p.epf_employer)}</td></tr></table>
    <p class="muted" style="font-size:.8rem">KWSP dikira dengan kadar anggaran (11% / 13% atau 12%). PERKESO, SIP dan PCB belum dikira automatik.</p></div>`;
};

// ----- HR -----
VIEWS.pekerja = async (main) => {
  const emps = await api("/hr/employees");
  const editable = can("pengurus");
  const opts = (sel) => `<option value="">—</option>` + emps.map((e) => `<option value="${e.id}" ${e.id === sel ? "selected" : ""}>${esc(e.name)}</option>`).join("");
  main.innerHTML = `<div class="row"><h1>Pekerja</h1><span class="spacer"></span>${editable ? `<button class="primary" id="addBtn">+ Pekerja</button>` : ""}</div>
    ${table(["Nama", "Jawatan", "Jabatan", "Mula", "Gaji pokok (RM)", "Pengurus", "Log masuk", "Status", ""], emps.map((e) =>
      `<tr><td>${esc(e.name)}</td><td>${esc(e.position)}</td><td>${esc(e.department)}</td><td>${esc(e.join_date)}</td><td class="num">${rm(e.basic_salary)}</td>
      <td>${esc(e.manager_name || "—")}</td><td>${e.email ? `${esc(e.email)} <span class="chip">${esc(ROLE_LABEL[e.role])}</span>` : `<span class="muted">tiada</span>`}</td>
      <td>${e.active ? chip("aktif") : chip("ditolak").replace("ditolak", "tidak aktif")}</td>
      <td>${editable ? `<button class="small" data-edit="${e.id}">Edit</button>` : ""}</td></tr>`))}
    <dialog id="dlg"><form id="f" class="grid" method="dialog">
      <input type="hidden" name="id">
      <label>Nama <input name="name" required></label>
      <label>No. KP <input name="ic_no"></label>
      <label>Jawatan <input name="position"></label>
      <label>Jabatan <input name="department"></label>
      <label>Tarikh mula <input type="date" name="join_date"></label>
      <label>Gaji pokok (RM) <input type="number" step="0.01" min="0" name="basic_salary" value="0"></label>
      <label>Cuti tahunan (hari) <input type="number" step="0.5" min="0" name="annual_leave_days" value="14"></label>
      <label>Pengurus <select name="manager_id"></select></label>
      <label>Status <select name="active"><option value="1">Aktif</option><option value="0">Tidak aktif</option></select></label>
      <div class="row"><button class="primary" type="submit">Simpan</button><button type="button" id="cancel">Batal</button></div>
      <p class="muted" style="grid-column:1/-1;font-size:.82rem">Untuk beri log masuk kepada pekerja, admin cipta pengguna di Tetapan dan pautkan kepada rekod pekerja ini.</p>
    </form></dialog>`;
  const dlg = $("#dlg"), f = $("#f");
  const open = (e = {}) => {
    f.reset();
    for (const [k, v] of Object.entries(e)) if (f.elements[k] && k !== "manager_id") f.elements[k].value = v ?? "";
    f.elements.manager_id.innerHTML = opts(e.manager_id);
    f.elements.active.value = e.active === 0 ? "0" : "1";
    dlg.showModal();
  };
  $("#addBtn")?.addEventListener("click", () => open());
  $("#cancel").onclick = () => dlg.close();
  $$("[data-edit]").forEach((b) => (b.onclick = () => open(emps.find((e) => e.id === Number(b.dataset.edit)))));
  onSubmit(f, async (d) => {
    const body = { ...d, active: d.active === "1" };
    await api(d.id ? `/hr/employees/${d.id}` : "/hr/employees", { method: d.id ? "PUT" : "POST", body });
    dlg.close(); toast("Disimpan"); route();
  });
};

VIEWS.kelulusan = async (main) => {
  const [leave, claims] = await Promise.all([api("/hr/leave?all=1"), api("/hr/claims?all=1")]);
  const pendingL = leave.filter((l) => l.status === "menunggu");
  const pendingC = claims.filter((c) => c.status === "menunggu");
  const btns = (kind, id) => `<button class="small ok" data-k="${kind}" data-id="${id}" data-s="lulus">Lulus</button> <button class="small bad" data-k="${kind}" data-id="${id}" data-s="ditolak">Tolak</button>`;
  main.innerHTML = `<h1>Kelulusan</h1>
    <h2>Cuti (${pendingL.length})</h2>
    ${table(["Pekerja", "Jenis", "Dari", "Hingga", "Hari", "Sebab", ""], pendingL.map((l) =>
      `<tr><td>${esc(l.name)}</td><td>${esc(l.leave_type)}</td><td>${esc(l.start_date)}</td><td>${esc(l.end_date)}</td><td class="num">${l.days}</td><td>${esc(l.reason)}</td><td>${btns("leave", l.id)}</td></tr>`), "Tiada permohonan menunggu.")}
    <h2>Tuntutan (${pendingC.length})</h2>
    ${table(["Pekerja", "Tarikh", "Kategori", "Keterangan", "Jumlah (RM)", ""], pendingC.map((c) =>
      `<tr><td>${esc(c.name)}</td><td>${esc(c.claim_date)}</td><td>${esc(c.category)}</td><td>${esc(c.description)}</td><td class="num">${rm(c.amount)}</td><td>${btns("claims", c.id)}</td></tr>`), "Tiada tuntutan menunggu.")}
    <h2>Sejarah cuti</h2>
    ${table(["Pekerja", "Jenis", "Dari", "Hingga", "Hari", "Status", "Oleh"], leave.filter((l) => l.status !== "menunggu").slice(0, 50).map((l) =>
      `<tr><td>${esc(l.name)}</td><td>${esc(l.leave_type)}</td><td>${esc(l.start_date)}</td><td>${esc(l.end_date)}</td><td class="num">${l.days}</td><td>${chip(l.status)}</td><td>${esc(l.decided_by_name)}</td></tr>`))}`;
  $$("[data-k]").forEach((b) => (b.onclick = () => act(() => api(`/hr/${b.dataset.k}/${b.dataset.id}/decide`, { body: { status: b.dataset.s } }), "Dikemas kini")));
};

VIEWS.kehadiran = async (main) => {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const from = q.get("from") || todayStr().slice(0, 8) + "01", to = q.get("to") || todayStr();
  const rows = await api(`/hr/attendance?all=1&from=${from}&to=${to}`);
  const map = (lat, lng) => (lat != null ? `<a href="https://maps.google.com/?q=${lat},${lng}" target="_blank" rel="noopener">📍</a>` : "");
  main.innerHTML = `<h1>Kehadiran</h1>
    <form class="grid panel" id="f"><label>Dari <input type="date" name="from" value="${from}"></label><label>Hingga <input type="date" name="to" value="${to}"></label><button>Tapis</button></form>
    ${table(["Tarikh", "Pekerja", "Masuk", "Keluar", "Jam"], rows.map((a) => {
      const hrs = a.clock_in && a.clock_out ? ((new Date(a.clock_out) - new Date(a.clock_in)) / 36e5).toFixed(1) : "—";
      return `<tr><td>${esc(a.work_date)}</td><td>${esc(a.name)}</td><td>${time(a.clock_in)} ${map(a.in_lat, a.in_lng)}</td><td>${time(a.clock_out)} ${map(a.out_lat, a.out_lng)}</td><td>${hrs}</td></tr>`;
    }))}`;
  $("#f").onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); location.hash = `#/kehadiran?from=${d.from}&to=${d.to}`; };
};

VIEWS.gaji = async (main) => {
  const [preview, slips] = await Promise.all([api("/hr/payroll/preview"), api("/hr/payslips?all=1")]);
  const now = todayStr().slice(0, 7);
  main.innerHTML = `<h1>Gaji</h1>
    <div class="panel"><h2 style="margin-top:0">Jana gaji bulanan</h2>
      <form id="f">
        <label style="max-width:200px">Bulan <input type="month" name="period" value="${now}" required></label>
        ${table(["Pekerja", "Gaji pokok (RM)", "Elaun (RM)", "Potongan lain (RM)"], preview.map((p) =>
          `<tr><td>${esc(p.name)}</td><td class="num">${rm(p.basic)}</td>
           <td><input type="number" step="0.01" min="0" value="0" data-emp="${p.employee_id}" data-f="allowances"></td>
           <td><input type="number" step="0.01" min="0" value="0" data-emp="${p.employee_id}" data-f="other_deductions"></td></tr>`), "Tiada pekerja aktif dengan gaji pokok.")}
        <p class="muted" style="font-size:.85rem">KWSP dikira automatik (anggaran 11% pekerja; 13%/12% majikan). PERKESO, SIP dan PCB belum disokong — masukkan dalam "Potongan lain" jika perlu.</p>
        <button class="primary" ${preview.length ? "" : "disabled"}>Jana gaji & rekod jurnal</button>
      </form></div>
    <h2>Slip gaji</h2>
    ${table(["Bulan", "Pekerja", "Kasar (RM)", "KWSP pekerja (RM)", "KWSP majikan (RM)", "Bersih (RM)", ""], slips.map((p) =>
      `<tr><td>${esc(p.period)}</td><td>${esc(p.name)}</td><td class="num">${rm(p.basic + p.allowances)}</td><td class="num">${rm(p.epf_employee)}</td><td class="num">${rm(p.epf_employer)}</td><td class="num">${rm(p.net_pay)}</td><td><a href="#/slip/${p.id}">Lihat</a></td></tr>`))}`;
  onSubmit($("#f"), async (d) => {
    const items = {};
    $$("[data-emp]").forEach((i) => { (items[i.dataset.emp] ??= { employee_id: Number(i.dataset.emp) })[i.dataset.f] = i.value; });
    if (!confirm(`Jana gaji untuk ${d.period}? Tindakan ini merekod jurnal dan tidak boleh dibatalkan.`)) return;
    const r = await api("/hr/payroll/run", { body: { period: d.period, items: Object.values(items) } });
    toast(`${r.count} slip dijana. Bersih ${rm(r.net)}`); route();
  });
};

// ----- Kewangan -----
VIEWS.invois = async (main, [id]) => {
  if (id === "baru") return invoiceForm(main);
  if (id) return invoiceView(main, id);
  const list = await api("/finance/invoices");
  const t = todayStr();
  main.innerHTML = `<div class="row"><h1>Invois</h1><span class="spacer"></span><a class="btn" href="#/invois/baru">+ Invois baru</a></div>
    ${table(["No.", "Pelanggan", "Tarikh", "Tarikh akhir", "Jumlah (RM)", "Baki (RM)", "Status"], list.map((i) =>
      `<tr><td><a href="#/invois/${i.id}">${esc(i.number)}</a></td><td>${esc(i.customer_name)}</td><td>${esc(i.issue_date)}</td>
       <td>${esc(i.due_date || "—")}${i.status !== "dibayar" && i.due_date && i.due_date < t ? ` <span class="chip bad">lewat</span>` : ""}</td>
       <td class="num">${rm(i.total)}</td><td class="num">${rm(i.total - i.paid)}</td><td>${chip(i.status)}</td></tr>`))}`;
};

async function invoiceForm(main) {
  const contacts = await api("/crm/contacts");
  main.innerHTML = `<h1>Invois baru</h1><div class="panel"><form id="f">
    <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.7rem">
      <label>Kenalan CRM (pilihan) <select name="contact_id"><option value="">—</option>${contacts.map((c) => `<option value="${c.id}" data-name="${esc(c.company || c.name)}">${esc(c.name)}${c.company ? " · " + esc(c.company) : ""}</option>`).join("")}</select></label>
      <label>Nama pelanggan <input name="customer_name" required></label>
      <label>Tarikh <input type="date" name="issue_date" value="${todayStr()}" required></label>
      <label>Tarikh akhir bayar <input type="date" name="due_date"></label>
    </div>
    <h2>Item</h2>
    <div class="table-wrap"><table class="lines-table"><thead><tr><th>Keterangan</th><th>Kuantiti</th><th>Harga seunit</th><th>SST</th><th class="num">Jumlah</th><th></th></tr></thead><tbody id="lines"></tbody></table></div>
    <button type="button" id="addLine" class="small">+ Baris</button>
    <p class="num" style="text-align:right" id="totals"></p>
    <label>Nota <textarea name="notes"></textarea></label>
    <div class="row" style="margin-top:.8rem"><button class="primary" type="submit">Simpan invois</button><a href="#/invois">Batal</a></div>
  </form></div>`;
  const tbody = $("#lines");
  const addLine = () => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td><input data-f="description" required></td><td><input type="number" step="any" min="0" value="1" data-f="qty"></td>
      <td><input type="number" step="0.01" min="0" value="0" data-f="unit_price"></td>
      <td><select data-f="sst_rate"><option value="0">0%</option><option value="6">6%</option><option value="8">8%</option><option value="5">5%</option><option value="10">10%</option></select></td>
      <td class="num" data-amt></td><td><button type="button" class="small bad">✕</button></td>`;
    tr.querySelector("button").onclick = () => { tr.remove(); calc(); };
    tbody.append(tr); calc();
  };
  const readLines = () => $$("tr", tbody).map((tr) => Object.fromEntries($$("[data-f]", tr).map((i) => [i.dataset.f, i.value])));
  const calc = () => {
    let sub = 0, sst = 0;
    $$("tr", tbody).forEach((tr) => {
      const l = Object.fromEntries($$("[data-f]", tr).map((i) => [i.dataset.f, i.value]));
      const a = Math.round(l.qty * l.unit_price * 100) / 100; const s = Math.round(a * l.sst_rate) / 100;
      sub += a; sst += s; tr.querySelector("[data-amt]").textContent = rm(a);
    });
    $("#totals").innerHTML = `Subjumlah ${rm(sub)} · SST ${rm(sst)} · <strong>Jumlah ${rm(sub + sst)}</strong>`;
  };
  tbody.addEventListener("input", calc);
  $("#addLine").onclick = addLine; addLine();
  $("[name=contact_id]").onchange = (e) => { const o = e.target.selectedOptions[0]; if (o.value) $("[name=customer_name]").value = o.dataset.name; };
  onSubmit($("#f"), async (d) => {
    const r = await api("/finance/invoices", { body: { ...d, lines: readLines() } });
    toast(`Invois ${r.number} disimpan`); location.hash = `#/invois/${r.id}`;
  });
}

async function invoiceView(main, id) {
  const i = await api(`/finance/invoices/${id}`);
  const bal = Math.round((i.total - i.paid) * 100) / 100;
  main.innerHTML = `<div class="panel">
    <div class="row"><h1 style="margin:0">Invois ${esc(i.number)}</h1><span class="spacer"></span>${chip(i.status)}<button class="no-print" onclick="print()">Cetak</button></div>
    <p><strong>${esc(state.status.company)}</strong></p>
    <p>Kepada: <strong>${esc(i.customer_name)}</strong><br>Tarikh: ${esc(i.issue_date)}${i.due_date ? ` · Tarikh akhir: ${esc(i.due_date)}` : ""}</p>
    ${table(["Keterangan", "Kuantiti", "Harga seunit", "SST", "Jumlah (RM)"], i.lines.map((l) =>
      `<tr><td>${esc(l.description)}</td><td>${l.qty}</td><td>${rm(l.unit_price)}</td><td>${l.sst_rate}% (${rm(l.sst_amount)})</td><td class="num">${rm(l.amount)}</td></tr>`))}
    <table style="max-width:320px;margin-left:auto"><tr><td>Subjumlah</td><td class="num">${rm(i.subtotal)}</td></tr><tr><td>SST</td><td class="num">${rm(i.sst_total)}</td></tr>
      <tr class="total"><td>Jumlah</td><td class="num">${rm(i.total)}</td></tr><tr><td>Dibayar</td><td class="num">${rm(i.paid)}</td></tr><tr class="total"><td>Baki</td><td class="num">${rm(bal)}</td></tr></table>
    ${i.notes ? `<p>${esc(i.notes)}</p>` : ""}
  </div>
  <div class="no-print">
    ${bal > 0 ? `<h2>Rekod bayaran</h2><div class="panel"><form class="grid" id="pf">
      <label>Tarikh <input type="date" name="pay_date" value="${todayStr()}"></label>
      <label>Jumlah (RM) <input type="number" step="0.01" min="0.01" max="${bal}" name="amount" value="${bal}" required></label>
      <label>Kaedah <select name="method"><option>Pindahan bank</option><option>DuitNow</option><option>Tunai</option><option>Cek</option><option>Kad</option></select></label>
      <button class="primary">Rekod</button></form></div>` : ""}
    <h2>Sejarah bayaran</h2>
    ${table(["Tarikh", "Kaedah", "Jumlah (RM)"], i.payments.map((p) => `<tr><td>${esc(p.pay_date)}</td><td>${esc(p.method)}</td><td class="num">${rm(p.amount)}</td></tr>`))}
    <p><a href="#/invois">← Semua invois</a></p></div>`;
  if ($("#pf")) onSubmit($("#pf"), (d) => act(() => api(`/finance/invoices/${id}/payments`, { body: d }), "Bayaran direkod"));
}

VIEWS.belanja = async (main) => {
  const [list, accounts] = await Promise.all([api("/finance/expenses"), api("/finance/accounts")]);
  main.innerHTML = `<h1>Perbelanjaan</h1>
    <div class="panel"><form class="grid" id="f">
      <label>Tarikh <input type="date" name="expense_date" value="${todayStr()}" required></label>
      <label>Pembekal <input name="vendor" required></label>
      <label>Akaun <select name="account_id">${accounts.filter((a) => a.type === "belanja").map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join("")}</select></label>
      <label>Jumlah (RM) <input type="number" step="0.01" min="0.01" name="amount" required></label>
      <label>Keterangan <input name="description"></label>
      <button class="primary">Rekod</button>
    </form></div>
    ${table(["Tarikh", "Pembekal", "Akaun", "Keterangan", "Jumlah (RM)"], list.map((x) =>
      `<tr><td>${esc(x.expense_date)}</td><td>${esc(x.vendor)}</td><td>${esc(x.code)} ${esc(x.account_name)}</td><td>${esc(x.description)}</td><td class="num">${rm(x.amount)}</td></tr>`))}`;
  onSubmit($("#f"), (d) => act(() => api("/finance/expenses", { body: d }), "Belanja direkod"));
};

VIEWS["tuntutan-bayar"] = async (main) => {
  const claims = await api("/hr/claims?all=1");
  const toPay = claims.filter((c) => c.status === "lulus");
  main.innerHTML = `<h1>Bayar Tuntutan</h1>
    ${table(["Pekerja", "Tarikh", "Kategori", "Keterangan", "Diluluskan oleh", "Jumlah (RM)", ""], toPay.map((c) =>
      `<tr><td>${esc(c.name)}</td><td>${esc(c.claim_date)}</td><td>${esc(c.category)}</td><td>${esc(c.description)}</td><td>${esc(c.decided_by_name)}</td><td class="num">${rm(c.amount)}</td>
       <td><button class="small primary" data-pay="${c.id}">Tanda dibayar</button></td></tr>`), "Tiada tuntutan untuk dibayar.")}
    <h2>Sudah dibayar</h2>
    ${table(["Pekerja", "Tarikh", "Kategori", "Jumlah (RM)"], claims.filter((c) => c.status === "dibayar").slice(0, 50).map((c) =>
      `<tr><td>${esc(c.name)}</td><td>${esc(c.claim_date)}</td><td>${esc(c.category)}</td><td class="num">${rm(c.amount)}</td></tr>`))}`;
  $$("[data-pay]").forEach((b) => (b.onclick = () => act(() => api(`/hr/claims/${b.dataset.pay}/pay`, { body: {} }), "Dibayar & jurnal direkod")));
};

VIEWS.jurnal = async (main) => {
  const [entries, accounts] = await Promise.all([api("/finance/journal"), api("/finance/accounts")]);
  const accOpts = accounts.map((a) => `<option value="${a.id}">${esc(a.code)} ${esc(a.name)}</option>`).join("");
  main.innerHTML = `<h1>Jurnal & Akaun</h1>
    <div class="tabs"><button class="active" data-tab="j">Jurnal</button><button data-tab="m">Catatan manual</button><button data-tab="a">Carta akaun</button></div>
    <div data-pane="j">
      <p class="muted">Catatan jurnal tidak boleh diubah atau dipadam. Untuk membetulkan kesilapan, buat catatan pembalikan.</p>
      ${table(["#", "Tarikh", "Memo", "Sumber", "Akaun", "Debit (RM)", "Kredit (RM)"], entries.flatMap((e) => e.lines.map((l, idx) =>
        `<tr>${idx === 0 ? `<td rowspan="${e.lines.length}">${e.id}</td><td rowspan="${e.lines.length}">${esc(e.entry_date)}</td><td rowspan="${e.lines.length}">${esc(e.memo)}<br><span class="muted">${esc(e.user_name || "")}</span></td><td rowspan="${e.lines.length}"><span class="chip">${esc(e.source)}</span></td>` : ""}
         <td>${esc(l.code)} ${esc(l.name)}</td><td class="num">${l.debit ? rm(l.debit) : ""}</td><td class="num">${l.credit ? rm(l.credit) : ""}</td></tr>`)))}
    </div>
    <div data-pane="m" hidden><div class="panel"><form id="mf">
      <div class="grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:.7rem">
        <label>Tarikh <input type="date" name="entry_date" value="${todayStr()}"></label><label>Memo <input name="memo" required placeholder="cth Modal permulaan"></label></div>
      <table class="lines-table"><thead><tr><th>Akaun</th><th>Debit</th><th>Kredit</th></tr></thead><tbody>
        ${[0, 1, 2, 3].map(() => `<tr><td><select data-f="account_id"><option value="">—</option>${accOpts}</select></td><td><input type="number" step="0.01" min="0" data-f="debit"></td><td><input type="number" step="0.01" min="0" data-f="credit"></td></tr>`).join("")}
      </tbody></table>
      <button class="primary" style="margin-top:.6rem">Rekod catatan</button></form></div></div>
    <div data-pane="a" hidden>
      ${table(["Kod", "Nama", "Jenis", "Debit (RM)", "Kredit (RM)"], accounts.map((a) => `<tr><td>${esc(a.code)}</td><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td class="num">${rm(a.debit)}</td><td class="num">${rm(a.credit)}</td></tr>`))}
      <h2>Tambah akaun</h2><div class="panel"><form class="grid" id="af">
        <label>Kod <input name="code" required></label><label>Nama <input name="name" required></label>
        <label>Jenis <select name="type"><option>aset</option><option>liabiliti</option><option>ekuiti</option><option>hasil</option><option>belanja</option></select></label>
        <button class="primary">Tambah</button></form></div>
    </div>`;
  $$("[data-tab]").forEach((b) => (b.onclick = () => {
    $$("[data-tab]").forEach((x) => x.classList.toggle("active", x === b));
    $$("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  }));
  onSubmit($("#mf"), (d, form) => {
    const lines = $$("tbody tr", form).map((tr) => Object.fromEntries($$("[data-f]", tr).map((i) => [i.dataset.f, i.value]))).filter((l) => l.account_id);
    return act(() => api("/finance/journal", { body: { ...d, lines } }), "Catatan direkod");
  });
  onSubmit($("#af"), (d) => act(() => api("/finance/accounts", { body: d }), "Akaun ditambah"));
};

VIEWS.laporan = async (main) => {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const from = q.get("from") || todayStr().slice(0, 4) + "-01-01", to = q.get("to") || todayStr();
  const [pl, bs, tb, sst] = await Promise.all([
    api(`/finance/reports/profit-loss?from=${from}&to=${to}`), api(`/finance/reports/balance-sheet?to=${to}`),
    api(`/finance/reports/trial-balance?to=${to}`), api(`/finance/reports/sst?from=${from}&to=${to}`)]);
  const section = (title, rows, total) => `<tr><td colspan="2"><strong>${esc(title)}</strong></td></tr>
    ${rows.map((r) => `<tr><td>&nbsp;&nbsp;${esc(r.code)} ${esc(r.name)}</td><td class="num">${rm(r.amount)}</td></tr>`).join("")}
    <tr class="total"><td>Jumlah ${esc(title.toLowerCase())}</td><td class="num">${rm(total)}</td></tr>`;
  main.innerHTML = `<div class="row"><h1>Laporan</h1><span class="spacer"></span><button class="no-print" onclick="print()">Cetak</button></div>
    <form class="grid panel no-print" id="f"><label>Dari <input type="date" name="from" value="${from}"></label><label>Hingga <input type="date" name="to" value="${to}"></label><button>Kemas kini</button></form>
    <div class="panel"><h2 style="margin-top:0">Untung Rugi (${esc(from)} – ${esc(to)})</h2>
      <table>${section("Hasil", pl.revenue, pl.totalRevenue)}${section("Belanja", pl.expenses, pl.totalExpenses)}
      <tr class="total"><td>${pl.profit >= 0 ? "Untung bersih" : "Rugi bersih"}</td><td class="num">${rm(pl.profit)}</td></tr></table></div>
    <div class="panel"><h2 style="margin-top:0">Kunci Kira-kira (setakat ${esc(to)})</h2>
      <table>${section("Aset", bs.assets, bs.totalAssets)}${section("Liabiliti", bs.liabilities, bs.totalLiabilities)}${section("Ekuiti", bs.equity, bs.totalEquity)}
      <tr class="total"><td>Liabiliti + Ekuiti</td><td class="num">${rm(bs.totalLiabilities + bs.totalEquity)}</td></tr></table>
      ${Math.abs(bs.totalAssets - bs.totalLiabilities - bs.totalEquity) > 0.005 ? `<p class="chip bad">Tidak seimbang — semak jurnal</p>` : `<p class="chip ok">Seimbang ✔</p>`}</div>
    <div class="panel"><h2 style="margin-top:0">Imbangan Duga (setakat ${esc(to)})</h2>
      ${table(["Akaun", "Debit (RM)", "Kredit (RM)"], [...tb.rows.map((r) => `<tr><td>${esc(r.code)} ${esc(r.name)}</td><td class="num">${r.dr ? rm(r.dr) : ""}</td><td class="num">${r.cr ? rm(r.cr) : ""}</td></tr>`),
        `<tr class="total"><td>Jumlah</td><td class="num">${rm(tb.totalDr)}</td><td class="num">${rm(tb.totalCr)}</td></tr>`])}</div>
    <div class="panel"><h2 style="margin-top:0">Ringkasan SST (${esc(from)} – ${esc(to)})</h2>
      ${table(["Kadar", "Nilai bercukai (RM)", "SST (RM)"], sst.rows.map((r) => `<tr><td>${r.sst_rate}%</td><td class="num">${rm(r.taxable)}</td><td class="num">${rm(r.sst)}</td></tr>`))}</div>`;
  $("#f").onsubmit = (e) => { e.preventDefault(); const d = formData(e.target); location.hash = `#/laporan?from=${d.from}&to=${d.to}`; };
};

// ----- CRM -----
const STAGES = [["baru", "Baru"], ["dihubungi", "Dihubungi"], ["sebut_harga", "Sebut harga"], ["rundingan", "Rundingan"], ["menang", "Menang"], ["kalah", "Kalah"]];

VIEWS.pipeline = async (main) => {
  const [deals, contacts] = await Promise.all([api("/crm/deals"), api("/crm/contacts")]);
  main.innerHTML = `<div class="row"><h1>Pipeline</h1><span class="spacer"></span><button class="primary" id="addBtn">+ Urus niaga</button></div>
    <div class="kanban">${STAGES.map(([k, label]) => {
      const ds = deals.filter((d) => d.stage === k);
      return `<div class="col"><h3><span>${label}</span><span class="muted">${ds.length} · ${rm(ds.reduce((s, d) => s + d.value, 0))}</span></h3>
        ${ds.map((d) => `<div class="deal"><strong>${esc(d.title)}</strong><br>
          <span class="muted">${esc(d.contact_name || "—")}${d.company ? " · " + esc(d.company) : ""}</span><br>
          ${rm(d.value)} <span class="muted">· ${esc(d.owner_name || "")}</span>
          <select data-deal="${d.id}" aria-label="Tukar peringkat">${STAGES.map(([sk, sl]) => `<option value="${sk}" ${sk === k ? "selected" : ""}>${sl}</option>`).join("")}</select></div>`).join("")}
      </div>`;
    }).join("")}</div>
    <dialog id="dlg"><form id="f" class="grid" method="dialog">
      <label>Tajuk <input name="title" required></label>
      <label>Kenalan <select name="contact_id"><option value="">—</option>${contacts.map((c) => `<option value="${c.id}">${esc(c.name)}${c.company ? " · " + esc(c.company) : ""}</option>`).join("")}</select></label>
      <label>Nilai (RM) <input type="number" step="0.01" min="0" name="value" value="0"></label>
      <label>Jangka tutup <input type="date" name="expected_close"></label>
      <div class="row"><button class="primary" type="submit">Simpan</button><button type="button" id="cancel">Batal</button></div>
    </form></dialog>`;
  $$("[data-deal]").forEach((s) => (s.onchange = () => act(() => api(`/crm/deals/${s.dataset.deal}`, { method: "PUT", body: { stage: s.value } }), "Peringkat dikemas kini")));
  const dlg = $("#dlg");
  $("#addBtn").onclick = () => dlg.showModal();
  $("#cancel").onclick = () => dlg.close();
  onSubmit($("#f"), async (d) => { await api("/crm/deals", { body: d }); dlg.close(); toast("Urus niaga ditambah"); route(); });
};

VIEWS.kenalan = async (main, [id]) => {
  if (id) return contactView(main, id);
  const list = await api("/crm/contacts");
  main.innerHTML = `<div class="row"><h1>Kenalan</h1><span class="spacer"></span><input id="q" placeholder="Cari…" style="max-width:240px"></div>
    <div class="panel"><form class="grid" id="f">
      <label>Nama <input name="name" required></label><label>Syarikat <input name="company"></label>
      <label>Telefon <input name="phone" type="tel"></label><label>E-mel <input name="email" type="email"></label>
      <label>Sumber <select name="source"><option value="">—</option><option>rujukan</option><option>media_sosial</option><option>iklan</option><option>walk_in</option><option>borang_web</option><option>lain</option></select></label>
      <button class="primary">Tambah kenalan</button></form>
      <p class="muted" style="font-size:.82rem;margin-bottom:0">Borang lead awam untuk laman web anda: <a href="/lead" target="_blank">${esc(location.origin)}/lead</a></p></div>
    <div id="tbl">${contactTable(list)}</div>`;
  onSubmit($("#f"), (d) => act(() => api("/crm/contacts", { body: d }), "Kenalan ditambah"));
  let timer;
  $("#q").oninput = (e) => { clearTimeout(timer); timer = setTimeout(async () => { $("#tbl").innerHTML = contactTable(await api(`/crm/contacts?q=${encodeURIComponent(e.target.value)}`)); }, 250); };
};
const contactTable = (list) => table(["Nama", "Syarikat", "Telefon", "E-mel", "Sumber", "Urus niaga", "Pemilik"], list.map((c) =>
  `<tr><td><a href="#/kenalan/${c.id}">${esc(c.name)}</a></td><td>${esc(c.company)}</td><td>${c.phone ? `<a href="https://wa.me/${esc(c.phone.replace(/\D/g, "").replace(/^0/, "60"))}" target="_blank" rel="noopener">${esc(c.phone)}</a>` : ""}</td>
   <td>${esc(c.email)}</td><td>${esc(c.source)}</td><td>${c.deal_count}</td><td>${esc(c.owner_name)}</td></tr>`));

async function contactView(main, id) {
  const c = await api(`/crm/contacts/${id}`);
  main.innerHTML = `<p><a href="#/kenalan">← Kenalan</a></p><h1>${esc(c.name)}</h1>
    <div class="panel"><form class="grid" id="f">
      <label>Nama <input name="name" value="${esc(c.name)}" required></label><label>Syarikat <input name="company" value="${esc(c.company)}"></label>
      <label>Telefon <input name="phone" value="${esc(c.phone)}"></label><label>E-mel <input name="email" value="${esc(c.email)}"></label>
      <label>Sumber <input name="source" value="${esc(c.source)}"></label><label style="grid-column:1/-1">Nota <textarea name="notes">${esc(c.notes)}</textarea></label>
      <button class="primary">Simpan</button></form></div>
    <h2>Urus niaga</h2>
    ${table(["Tajuk", "Nilai (RM)", "Peringkat"], c.deals.map((d) => `<tr><td>${esc(d.title)}</td><td class="num">${rm(d.value)}</td><td>${chip(d.stage)}</td></tr>`))}
    <h2>Aktiviti</h2>
    <div class="panel"><form class="grid" id="af">
      <label>Jenis <select name="kind"><option>panggilan</option><option>whatsapp</option><option>emel</option><option>mesyuarat</option><option>nota</option></select></label>
      <label style="grid-column:span 2">Nota <input name="note" required></label><button class="primary">Log</button></form></div>
    ${table(["Masa", "Jenis", "Nota", "Oleh"], c.activities.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.kind)}</td><td>${esc(a.note)}</td><td>${esc(a.user_name)}</td></tr>`))}`;
  onSubmit($("#f"), (d) => act(() => api(`/crm/contacts/${id}`, { method: "PUT", body: d }), "Disimpan"));
  onSubmit($("#af"), (d) => act(() => api(`/crm/contacts/${id}/activities`, { body: d }), "Aktiviti dilog"));
}

// ----- AI -----
const chatHistory = [];
VIEWS.ai = async (main) => {
  const s = await api("/ai/status");
  const render = () => {
    $("#chat").innerHTML = chatHistory.length ? chatHistory.map((m) => `<div class="msg ${m.role}">${esc(m.content)}</div>`).join("")
      : `<p class="muted">Cuba: "Siapa yang belum bayar invois?", "Berapa belanja bulan ini ikut kategori?", "Urus niaga mana yang paling besar?"</p>`;
  };
  main.innerHTML = `<h1>Tanya AI</h1>
    <p class="muted">Pembantu ini membaca data HR, kewangan dan CRM yang anda dibenarkan lihat, dan menjawab soalan. Ia <strong>tidak boleh mengubah</strong> apa-apa data.</p>
    ${s.enabled ? "" : `<div class="panel"><strong>Belum diaktifkan.</strong> Admin perlu tetapkan <code>ANTHROPIC_API_KEY</code> pada pelayan.</div>`}
    <div class="chat" id="chat"></div>
    <form id="f" class="row"><input name="question" placeholder="Tanya tentang bisnes anda…" required style="flex:1" ${s.enabled ? "" : "disabled"}><button class="primary" ${s.enabled ? "" : "disabled"}>Hantar</button></form>`;
  render();
  onSubmit($("#f"), async (d, form) => {
    const history = chatHistory.slice(-6);
    chatHistory.push({ role: "user", content: d.question }); form.reset(); render();
    try {
      const r = await api("/ai/ask", { body: { question: d.question, history } });
      chatHistory.push({ role: "assistant", content: r.answer });
    } catch (err) { chatHistory.pop(); throw err; } finally { render(); }
  });
};

// ----- Tetapan & akaun -----
VIEWS.tetapan = async (main) => {
  const [users, emps, audit] = await Promise.all([api("/users"), api("/hr/employees"), api("/audit")]);
  const unlinked = emps.filter((e) => !e.user_id);
  main.innerHTML = `<h1>Tetapan</h1>
    <h2>Syarikat</h2><div class="panel"><form class="grid" id="cf"><label>Nama syarikat <input name="company" value="${esc(state.status.company)}" required></label><button class="primary">Simpan</button></form></div>
    <h2>Pengguna</h2>
    ${table(["Nama", "E-mel", "Peranan", "Status", ""], users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
      <td><select data-role="${u.id}">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === u.role ? "selected" : ""}>${v}</option>`).join("")}</select></td>
      <td>${u.active ? chip("aktif") : `<span class="chip bad">tidak aktif</span>`}</td>
      <td><button class="small" data-toggle="${u.id}" data-active="${u.active}">${u.active ? "Nyahaktif" : "Aktifkan"}</button></td></tr>`))}
    <div class="panel"><h2 style="margin-top:0">Tambah pengguna</h2><form class="grid" id="uf">
      <label>Nama <input name="name" required></label><label>E-mel <input name="email" type="email" required></label>
      <label>Kata laluan sementara <input name="password" type="text" minlength="8" required></label>
      <label>Peranan <select name="role">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === "pekerja" ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label>Pautkan ke pekerja <select name="employee_id"><option value="">—</option>${unlinked.map((e) => `<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select></label>
      <button class="primary">Tambah</button></form>
      <p class="muted" style="font-size:.82rem">Peranan: <b>Pekerja</b> – ruang sendiri & CRM sendiri. <b>Pengurus</b> – HR, kelulusan, semua CRM. <b>Kewangan</b> – perakaunan, gaji, bayar tuntutan. <b>Admin</b> – semua.</p></div>
    <h2>Log audit</h2>
    ${table(["Masa", "Pengguna", "Tindakan", "Butiran"], audit.map((a) => `<tr><td>${esc(a.at)}</td><td>${esc(a.user_name)}</td><td>${esc(a.action)}</td><td class="muted" style="font-size:.8rem">${esc(a.detail)}</td></tr>`))}`;
  onSubmit($("#cf"), async (d) => { await api("/settings", { method: "PUT", body: d }); state.status.company = d.company; toast("Disimpan"); renderShell(); });
  onSubmit($("#uf"), (d) => act(() => api("/users", { body: d }), "Pengguna ditambah"));
  $$("[data-role]").forEach((s) => (s.onchange = () => act(() => api(`/users/${s.dataset.role}`, { method: "PUT", body: { role: s.value } }), "Peranan dikemas kini")));
  $$("[data-toggle]").forEach((b) => (b.onclick = () => act(() => api(`/users/${b.dataset.toggle}`, { method: "PUT", body: { active: b.dataset.active !== "1" } }), "Dikemas kini")));
};

VIEWS.akaun = async (main) => {
  main.innerHTML = `<h1>Akaun Saya</h1><p>${esc(state.user.name)} · ${esc(state.user.email)} · ${ROLE_LABEL[state.user.role]}</p>
    <div class="panel" style="max-width:420px"><h2 style="margin-top:0">Tukar kata laluan</h2><form id="f" class="auth" style="margin:0;padding:0;display:grid;gap:.7rem">
      <label>Kata laluan semasa <input type="password" name="current" required></label>
      <label>Kata laluan baru (min 8) <input type="password" name="password" minlength="8" required></label>
      <button class="primary">Tukar</button></form></div>`;
  onSubmit($("#f"), async (d, form) => { await api("/me/password", { body: d }); form.reset(); toast("Kata laluan ditukar"); });
};

boot();
