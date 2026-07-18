// src/index.ts

import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import aiRoutes from "./routes/ai";
import authRoutes from "./routes/auth";

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    // In dev, allow all. In prod, lock to your specific origins.
    origin:
      allowedOrigins.length > 0
        ? (origin, cb) => {
            if (!origin || allowedOrigins.includes(origin)) {
              cb(null, true);
            } else {
              cb(new Error(`Origin ${origin} not allowed by CORS`));
            }
          }
        : true,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ── Body parsing ──────────────────────────────────────────────────────────────
// 50 MB to accommodate multiple base64-encoded screenshots
app.use(express.json({ limit: "50mb" }));

// ── Global rate limit (per IP) ────────────────────────────────────────────────
// This is a safety net on top of the per-user tier limits
app.use(
  rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 60,             // 60 requests/min per IP
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down." },
  })
);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api", authRoutes);
app.use("/api/ai", aiRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ── Multer error handler ──────────────────────────────────────────────────────
// Returns JSON instead of Express's default HTML error page for upload errors.
import multer from "multer";
import { ErrorRequestHandler } from "express";

const uploadErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (err instanceof multer.MulterError || err.message === "Only image files are accepted") {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
};

app.use(uploadErrorHandler);

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
});

export default app;
