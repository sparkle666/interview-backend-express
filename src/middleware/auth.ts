// src/middleware/auth.ts
//
// Verifies the JWT sent by the Electron app in the Authorization header.
// Attaches user info to req.user.
//
// For your SaaS: issue JWTs when users subscribe/log in via your web dashboard.
// The Electron app stores the token locally and sends it with every request.

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { JWTPayload, Tier } from "../types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice(7);
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET not configured");
    const payload = jwt.verify(token, secret) as JWTPayload;
    req.user = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ── Utility: generate a token (use this in your auth/subscription system) ────

export function issueToken(userId: string, email: string, tier: Tier): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET not configured");
  return jwt.sign({ userId, email, tier }, secret, { expiresIn: "30d" });
}
