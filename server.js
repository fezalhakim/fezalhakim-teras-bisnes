import express from "express";
import { openDb } from "./src/db.js";
import { sessionMiddleware } from "./src/auth.js";
import { InputError } from "./src/util.js";
import coreRoutes from "./src/routes/core.js";
import hrRoutes from "./src/routes/hr.js";
import financeRoutes from "./src/routes/finance.js";
import crmRoutes, { publicLeadRoute } from "./src/routes/crm.js";
import aiRoutes from "./src/routes/ai.js";

export function createApp(db = openDb()) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "200kb" }));

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    if (!req.path.startsWith("/lead")) res.set("X-Frame-Options", "DENY");
    next();
  });

  // Perlindungan CSRF: permintaan yang mengubah data mesti JSON (borang laman lain tidak boleh hantar JSON tanpa CORS).
  app.use("/api", (req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !req.is("application/json")) {
      return res.status(415).json({ error: "Content-Type mesti application/json." });
    }
    next();
  });

  app.get("/healthz", (req, res) => res.send("ok"));
  app.post("/api/public/lead", publicLeadRoute(db));

  app.use("/api", sessionMiddleware(db));
  app.use("/api", coreRoutes(db));
  app.use("/api/hr", hrRoutes(db));
  app.use("/api/finance", financeRoutes(db));
  app.use("/api/crm", crmRoutes(db));
  app.use("/api/ai", aiRoutes(db));
  app.use("/api", (req, res) => res.status(404).json({ error: "Tidak dijumpai." }));

  app.use(express.static("public", { extensions: ["html"] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof InputError) return res.status(err.status).json({ error: err.message });
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: "JSON tidak sah." });
    console.error(err);
    res.status(500).json({ error: "Ralat pelayan." });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 3000;
  createApp().listen(PORT, () => console.log(`Teras Bisnes berjalan di http://localhost:${PORT}`));
}
