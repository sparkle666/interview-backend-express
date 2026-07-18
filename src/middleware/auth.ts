// src/middleware/auth.ts
//
// Verifies the JWT sent by the Electron app in the Authorization header.
// Attaches user info to req.user.
//
// For your SaaS: issue JWTs when users subscribe/log in via your web dashboard.
// The Electron app stores the token locally and sends it with every request.

import { Request, Response, NextFunction } from "express";
import { createClient } from "@supabase/supabase-js";
import { JWTPayload, Tier } from "../types";

const loggedOutTokens = new Set<string>();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

function getSupabaseAuthClient() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Supabase auth not configured");
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

export function markTokenAsLoggedOut(token: string): void {
  loggedOutTokens.add(token);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = header.slice(7);

  if (loggedOutTokens.has(token)) {
    res.status(401).json({ error: "Token revoked" });
    return;
  }

  try {
    const client = getSupabaseAuthClient();
    const { data, error } = await client.auth.getUser(token);

    if (error || !data.user) {
      throw new Error(error?.message || "Supabase auth validation failed");
    }

    const tier = (data.user.user_metadata?.tier as Tier | undefined) || "free";

    req.user = {
      userId: data.user.id,
      email: data.user.email || "",
      tier,
    };

    next();
    return;
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
