// src/routes/auth.ts
//
// Minimal auth routes. In production, wire these up to your real user DB
// (Supabase, PlanetScale, Prisma, etc.). For now they let you test the flow.

import { Router, Request, Response } from "express";
import { z } from "zod";
import { issueToken } from "../middleware/auth";
import { Tier } from "../types";
import { usageTracker } from "../services/usageTracker";
import { requireAuth } from "../middleware/auth";

const router = Router();

// ── POST /api/auth/token ─────────────────────────────────────────────────────
// Dev/test endpoint: hand it a userId + tier, get back a JWT.
// In production, replace this with your real auth flow (OAuth, Stripe webhooks, etc.)

const tokenSchema = z.object({
  userId: z.string().min(1),
  email: z.string().email(),
  tier: z.enum(["free", "starter", "pro", "unlimited"]).default("free"),
  // Only allow this in dev or if a shared secret matches
  adminSecret: z.string().optional(),
});

router.post("/token", (req: Request, res: Response) => {
  // In production, remove this endpoint entirely and issue tokens from your
  // subscription/payment system (e.g. Stripe webhook → set tier → issue JWT)
  if (process.env.NODE_ENV === "production") {
    const { adminSecret } = req.body;
    if (!adminSecret || adminSecret !== process.env.ADMIN_SECRET) {
      res.status(403).json({ error: "Forbidden in production" });
      return;
    }
  }

  const parsed = tokenSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { userId, email, tier } = parsed.data;
  const token = issueToken(userId, email, tier as Tier);

  res.json({ token, tier, userId, email });
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Let the app verify its stored token is still valid and see its tier/usage

router.get("/me", requireAuth, (req: Request, res: Response) => {
  const user = req.user!;
  res.json({
    userId: user.userId,
    email: user.email,
    tier: user.tier,
    usage: usageTracker.summary(user.userId, user.tier),
  });
});

export default router;
