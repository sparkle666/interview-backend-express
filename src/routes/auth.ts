// src/routes/auth.ts
//
// Auth routes that stay compatible with the current desktop app while adding
// a Supabase-friendly auth flow.
//
// Compatibility note:
// - Existing clients can still use POST /api/auth/token and GET /api/auth/me
// - New routes add register/login/logout/refresh/forgot-password and
//   profile endpoints under /api/users/me

import { Router, Request, Response } from "express";
import { z } from "zod";
import { markTokenAsLoggedOut, requireAuth } from "../middleware/auth";
import { Tier } from "../types";
import { usageTracker } from "../services/usageTracker";
import {
  forgotPasswordWithSupabase,
  refreshSupabaseSession,
  signInWithSupabase,
  signOutWithSupabase,
  signUpWithSupabase,
  SupabaseAuthError,
} from "../services/supabaseAuth";

const router = Router();

// NOTE: tier is intentionally excluded from registerSchema and loginSchema.
// Tier is always resolved server-side from Supabase user_metadata, never
// trusted from the client. Accepting it from the client would allow privilege
// escalation (e.g. self-assigning "legend").
const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

// Tier updates must go through a privileged billing/admin flow, not here.
// Accepting tier from the client on PATCH /users/me would allow self-promotion.
const updateProfileSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
});

async function buildProfileResponse(req: Request) {
  const user = req.user!;
  const usage = await usageTracker.summary(user.userId, user.tier);
  return {
    success: true,
    user: {
      userId: user.userId,
      email: user.email,
      tier: user.tier,
    },
    usage,
  };
}

function handleAuthError(err: unknown, context: string, res: Response) {
  console.error(`[${context}]`, err);
  const status = err instanceof SupabaseAuthError ? err.statusCode : 500;
  res.status(status).json({
    success: false,
    error: (err as Error).message,
    details:
      err instanceof Error ? { name: err.name, message: err.message } : undefined,
  });
}

// ── POST /api/auth/register ─────────────────────────────────────────────────
router.post("/auth/register", async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { email, password, name } = parsed.data;

  try {
    const authResult = await signUpWithSupabase({ email, password, name });
    res.json({ success: true, ...authResult });
  } catch (err) {
    handleAuthError(err, "/auth/register", res);
  }
});

// ── POST /api/auth/login ────────────────────────────────────────────────────
router.post("/auth/login", async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const authResult = await signInWithSupabase({ email, password });
    res.json({ success: true, ...authResult });
  } catch (err) {
    handleAuthError(err, "/auth/login", res);
  }
});

// ── POST /api/auth/logout ───────────────────────────────────────────────────
router.post("/auth/logout", requireAuth, async (req: Request, res: Response) => {
  // Prefer an explicitly supplied Supabase access token in the body; fall back
  // to the Authorization header. Use a case-insensitive Bearer strip.
  const token =
    (req.body?.supabaseAccessToken as string | undefined) ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    "";

  if (!token) {
    res.status(400).json({ success: false, error: "No access token provided for logout." });
    return;
  }

  try {
    const result = await signOutWithSupabase(token);

    // Only blacklist the token locally if Supabase actually revoked the session.
    // Blacklisting an already-invalid or fabricated token pollutes the blacklist.
    if (result.supabaseSignedOut) {
      markTokenAsLoggedOut(token);
    }

    res.json({ success: true });
  } catch (err) {
    handleAuthError(err, "/auth/logout", res);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────
router.post("/auth/refresh", async (req: Request, res: Response) => {
  const parsed = refreshSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  try {
    const authResult = await refreshSupabaseSession(parsed.data.refreshToken);
    res.json({ success: true, ...authResult });
  } catch (err) {
    handleAuthError(err, "/auth/refresh", res);
  }
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────
router.post("/auth/forgot-password", async (req: Request, res: Response) => {
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  try {
    const result = await forgotPasswordWithSupabase(parsed.data.email);
    // res.json({ success: true, ...result });
    const { success, ...rest } = result;

    res.json({
      success: true,
      ...rest,
    });

  } catch (err) {
    handleAuthError(err, "/auth/forgot-password", res);
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
// Compatibility endpoint for the current desktop app.
router.get("/auth/me", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await buildProfileResponse(req));
  } catch (err) {
    handleAuthError(err, "/auth/me", res);
  }
});

// ── GET /api/users/me ──────────────────────────────────────────────────────
router.get("/users/me", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json(await buildProfileResponse(req));
  } catch (err) {
    handleAuthError(err, "/users/me GET", res);
  }
});

// ── PATCH /api/users/me ────────────────────────────────────────────────────
router.patch("/users/me", requireAuth, async (req: Request, res: Response) => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const user = req.user!;

  // Tier is never updated from the client here. To change a user's tier,
  // use a privileged billing/admin endpoint that validates entitlement.
  const updatedEmail = parsed.data.email ?? user.email;

  try {
    const usage = await usageTracker.summary(user.userId, user.tier);
    res.json({
      success: true,
      user: {
        userId: user.userId,
        email: updatedEmail,
        tier: user.tier, // always reflects server-side tier, never client input
      },
      usage,
    });
  } catch (err) {
    handleAuthError(err, "/users/me PATCH", res);
  }
});

export default router;