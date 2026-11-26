import crypto from "node:crypto";

const SESSION_DAYS = 7;
export const COOKIE = "teras_sid";

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Kata laluan mesti sekurang-kurangnya 8 aksara.";
  return null;
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(token, userId, expires);
  return { token, maxAge: SESSION_DAYS * 864e5 };
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function cookieOptions(req) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    path: "/",
  };
}

// Lampirkan req.user (atau null) pada setiap permintaan.
// Peranan dibaca semula dari pangkalan data setiap kali, jadi jika admin tukar peranan, kesannya serta-merta.
export function sessionMiddleware(db) {
  const q = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, e.id AS employee_id
    FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.active = 1
    LEFT JOIN employees e ON e.user_id = u.id
    WHERE s.token = ? AND s.expires_at > ?`);
  return (req, res, next) => {
    const token = readCookie(req, COOKIE);
    req.sessionToken = token;
    req.user = token ? q.get(token, new Date().toISOString()) ?? null : null;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Sila log masuk." });
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sila log masuk." });
    if (req.user.role !== "admin" && !roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Anda tiada akses untuk tindakan ini." });
    }
    next();
  };
}

// Had cubaan log masuk ringkas (dalam memori).
const attempts = new Map();
export function loginLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, reset: now + 15 * 60e3 };
  if (now > rec.reset) { rec.n = 0; rec.reset = now + 15 * 60e3; }
  rec.n++;
  attempts.set(key, rec);
  if (rec.n > 10) return res.status(429).json({ error: "Terlalu banyak cubaan. Cuba lagi dalam 15 minit." });
  next();
}
