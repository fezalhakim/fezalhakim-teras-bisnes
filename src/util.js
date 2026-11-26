// Ralat input yang dipaparkan terus kepada pengguna (HTTP 400).
export class InputError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

export function str(v, label, { required = true, max = 500 } = {}) {
  if (v == null || String(v).trim() === "") {
    if (required) throw new InputError(`${label} diperlukan.`);
    return null;
  }
  const s = String(v).trim();
  if (s.length > max) throw new InputError(`${label} terlalu panjang (maks ${max} aksara).`);
  return s;
}

export function num(v, label, { required = true, min = -Infinity, max = Infinity } = {}) {
  if (v == null || v === "") {
    if (required) throw new InputError(`${label} diperlukan.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new InputError(`${label} tidak sah.`);
  return n;
}

export function date(v, label, { required = true } = {}) {
  if (v == null || v === "") {
    if (required) throw new InputError(`${label} diperlukan.`);
    return null;
  }
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new InputError(`${label} mesti dalam format YYYY-MM-DD.`);
  return s;
}

export function oneOf(v, label, options) {
  if (!options.includes(v)) throw new InputError(`${label} tidak sah.`);
  return v;
}

// Tarikh tempatan (Malaysia, UTC+8) dalam format YYYY-MM-DD.
export function today(tz = process.env.TZ_NAME || "Asia/Kuala_Lumpur") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Bungkus handler supaya ralat dihantar ke pengendali ralat Express.
export const h = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === "function") r.catch(next);
  } catch (e) { next(e); }
};
