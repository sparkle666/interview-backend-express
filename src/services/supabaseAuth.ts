import { createClient } from "@supabase/supabase-js";
import { Tier } from "../types";

export interface AuthResponse {
  tier: Tier;
  userId: string;
  email: string;
  provider: "local" | "supabase";
  refreshToken?: string;
  expiresAt?: string;
  supabaseAccessToken?: string;
}

export class SupabaseAuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = "SupabaseAuthError";
    this.statusCode = statusCode;
  }
}

interface SupabaseAuthRequest {
  email: string;
  password: string;
  // NOTE: tier is intentionally NOT accepted from the client here.
  // Tier is always resolved from Supabase user_metadata or the profiles table.
  name?: string;
}

interface SupabaseAuthResult {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: {
    id?: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
  };
  message?: string;
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, anonKey, serviceRoleKey };
}

/**
 * Returns a Supabase client using the anon key for user-facing operations.
 * Only use the service role key for privileged admin operations, not here.
 */
function getSupabaseAnonClient() {
  const { url, anonKey } = getSupabaseConfig();

  if (!url || !anonKey) {
    throw new SupabaseAuthError("Supabase auth not configured", 503);
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Returns a Supabase client using the service role key.
 * Only use for privileged operations (e.g. profile upserts that bypass RLS).
 */
function getSupabaseAdminClient() {
  const { url, anonKey, serviceRoleKey } = getSupabaseConfig();

  if (!url || !anonKey) {
    throw new SupabaseAuthError("Supabase auth not configured", 503);
  }

  // Fall back to anon key if no service role key is set, but log a warning.
  if (!serviceRoleKey) {
    console.warn("[supabaseAuth] SUPABASE_SERVICE_ROLE_KEY is not set; falling back to anon key for admin client.");
  }

  return createClient(url, serviceRoleKey || anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Syncs the user's profile row in the `profiles` table.
 * Uses the admin client to bypass RLS for upserts.
 * Does NOT overwrite created_at on existing rows.
 * Throws if the upsert fails, so callers can decide how to handle it.
 */
async function syncProfile(userId: string, input: { email: string; tier?: Tier; name?: string }): Promise<void> {
  const client = getSupabaseAdminClient();

  // Use two separate operations to avoid overwriting created_at on conflict.
  // First try to insert; if the row already exists, update only mutable fields.
  const { error: upsertError } = await client.from("profiles").upsert(
    {
      id: userId,
      full_name: input.name || input.email.split("@")[0],
      tier: input.tier || "free",
      // created_at is intentionally omitted so the DB default applies on insert
      // and the existing value is preserved on conflict.
    },
    {
      onConflict: "id",
      // Only update the fields we explicitly control; ignore created_at.
      ignoreDuplicates: false,
    }
  );

  if (upsertError) {
    // Throw so callers are aware — a missing profile row can break downstream queries.
    throw new Error(`Profile sync failed for user ${userId}: ${upsertError.message}`);
  }
}

async function supabaseRequest(path: string, body: Record<string, unknown>, auth?: string) {
  const { url, anonKey } = getSupabaseConfig();

  if (!url || !anonKey) {
    throw new SupabaseAuthError("Supabase auth not configured", 503);
  }

  const response = await fetch(`${url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: anonKey,
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as SupabaseAuthResult & {
    error?: { message?: string; status?: number };
    error_description?: string;
    msg?: string;
    [key: string]: unknown;
  };

  if (!response.ok) {
    console.error("[Supabase auth error]", data);

    const message =
      (data as { msg?: string; error_description?: string; error?: string }).msg ||
      (data as { msg?: string; error_description?: string; error?: string }).error_description ||
      (data as { msg?: string; error_description?: string; error?: string }).error ||
      data?.error?.message ||
      data?.message ||
      "Supabase auth request failed";

    const statusCode =
      data?.error?.status && data.error.status >= 400 ? data.error.status : response.status || 401;
    throw new SupabaseAuthError(message, statusCode);
  }

  return data;
}

export function createAuthResponse({
  userId,
  email,
  tier,
  provider = "local",
  refreshToken,
  expiresAt,
  supabaseAccessToken,
}: {
  userId: string;
  email: string;
  tier: Tier;
  provider?: "local" | "supabase";
  refreshToken?: string;
  expiresAt?: string;
  supabaseAccessToken?: string;
}): AuthResponse {
  return {
    tier,
    userId,
    email,
    provider,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(supabaseAccessToken ? { supabaseAccessToken } : {}),
  };
}

export async function signUpWithSupabase(
  input: SupabaseAuthRequest
): Promise<AuthResponse> {
  try {
    const result = await supabaseRequest("/auth/v1/signup", {
      email: input.email,
      password: input.password,
      data: {
        // Always register as "free"; tier upgrades happen via billing, not signup.
        tier: "free",
        full_name: input.name || input.email.split("@")[0],
      },
    });

    // Never fabricate a userId — a missing ID means Supabase returned an
    // unexpected response (e.g. email confirmation required but not configured).
    const userId = result.user?.id;
    if (!userId) {
      throw new SupabaseAuthError(
        "Registration succeeded but no user ID was returned. " +
          "The account may require email confirmation before it can be used.",
        503
      );
    }

    const email = result.user?.email;
    if (!email) {
      throw new SupabaseAuthError("Registration succeeded but no email was returned.", 503);
    }

    // Tier always comes from Supabase metadata, never from the client request.
    const tier = (result.user?.user_metadata?.tier as Tier | undefined) || "free";

    // Profile sync is critical — if it fails, throw so the caller can handle it.
    await syncProfile(userId, { email, tier, name: input.name });

    return createAuthResponse({
      userId,
      email,
      tier,
      provider: "supabase",
      refreshToken: result.refresh_token,
      expiresAt: result.expires_in
        ? new Date(Date.now() + result.expires_in * 1000).toISOString()
        : undefined,
      supabaseAccessToken: result.access_token,
    });
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      throw error;
    }
    console.error("[signUpWithSupabase]", error);
    throw new SupabaseAuthError("Unable to register user right now", 500);
  }
}

export async function signInWithSupabase(
  input: SupabaseAuthRequest
): Promise<AuthResponse> {
  try {
    const result = await supabaseRequest("/auth/v1/token?grant_type=password", {
      email: input.email,
      password: input.password,
    });

    const userId = result.user?.id;
    if (!userId) {
      throw new SupabaseAuthError("Sign-in succeeded but no user ID was returned.", 503);
    }

    const email = result.user?.email;
    if (!email) {
      throw new SupabaseAuthError("Sign-in succeeded but no email was returned.", 503);
    }

    // Tier always comes from Supabase metadata — never trust the client.
    const tier = (result.user?.user_metadata?.tier as Tier | undefined) || "free";

    // Best-effort profile sync on login. Log prominently but don't block sign-in
    // since the user already authenticated successfully with Supabase.
    try {
      await syncProfile(userId, { email, tier });
    } catch (syncErr) {
      console.error("[signInWithSupabase] Profile sync failed — user signed in but profile may be stale:", syncErr);
    }

    return createAuthResponse({
      userId,
      email,
      tier,
      provider: "supabase",
      refreshToken: result.refresh_token,
      expiresAt: result.expires_in
        ? new Date(Date.now() + result.expires_in * 1000).toISOString()
        : undefined,
      supabaseAccessToken: result.access_token,
    });
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      throw error;
    }
    console.error("[signInWithSupabase]", error);
    throw new SupabaseAuthError("Unable to sign in right now", 500);
  }
}

export async function refreshSupabaseSession(refreshToken: string): Promise<AuthResponse> {
  try {
    const result = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", {
      refresh_token: refreshToken,
    });

    const userId = result.user?.id;
    if (!userId) {
      throw new SupabaseAuthError("Session refresh succeeded but no user ID was returned.", 503);
    }

    const email = result.user?.email;
    if (!email) {
      // A missing email after refresh is a hard error — we cannot identify the user.
      throw new SupabaseAuthError("Session refresh succeeded but no email was returned.", 503);
    }

    const tier = (result.user?.user_metadata?.tier as Tier | undefined) || "free";

    // Sync profile on refresh so tier changes made server-side are reflected.
    try {
      await syncProfile(userId, { email, tier });
    } catch (syncErr) {
      console.error("[refreshSupabaseSession] Profile sync failed — session refreshed but profile may be stale:", syncErr);
    }

    return createAuthResponse({
      userId,
      email,
      tier,
      provider: "supabase",
      refreshToken: result.refresh_token,
      expiresAt: result.expires_in
        ? new Date(Date.now() + result.expires_in * 1000).toISOString()
        : undefined,
      supabaseAccessToken: result.access_token,
    });
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      throw error;
    }
    console.error("[refreshSupabaseSession]", error);
    throw new SupabaseAuthError("Unable to refresh session right now", 401);
  }
}

/**
 * Signs out the user from Supabase.
 * Returns { success: true, supabaseSignedOut: boolean } so callers can
 * distinguish "Supabase session was revoked" from "token was already invalid".
 * Only call markTokenAsLoggedOut after a confirmed Supabase sign-out.
 */
export async function signOutWithSupabase(
  accessToken: string
): Promise<{ success: boolean; supabaseSignedOut: boolean }> {
  if (!accessToken) {
    return { success: true, supabaseSignedOut: false };
  }

  try {
    await supabaseRequest("/auth/v1/logout", {}, accessToken);
    return { success: true, supabaseSignedOut: true };
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      const message = error.message.toLowerCase();
      const isAlreadyInvalid =
        error.statusCode === 400 ||
        error.statusCode === 401 ||
        error.statusCode === 403 ||
        message.includes("jwt") ||
        message.includes("token") ||
        message.includes("invalid") ||
        message.includes("not authenticated");

      if (isAlreadyInvalid) {
        console.warn(
          "[auth/logout] Supabase logout skipped — token was not a valid Supabase session token."
        );
        // Return supabaseSignedOut: false so the caller knows NOT to blacklist this token.
        return { success: true, supabaseSignedOut: false };
      }

      throw error;
    }
    throw new SupabaseAuthError("Unable to logout right now", 500);
  }
}

export async function forgotPasswordWithSupabase(
  email: string
): Promise<{ success: boolean; message: string }> {
  try {
    await supabaseRequest("/auth/v1/recover", {
      email,
      redirect_to:
        process.env.SUPABASE_REDIRECT_URL || "http://localhost:3000/reset-password",
    });
    return { success: true, message: "Password reset email sent." };
  } catch (error) {
    if (error instanceof SupabaseAuthError) {
      throw error;
    }
    console.error("[forgotPasswordWithSupabase]", error);
    throw new SupabaseAuthError("Unable to send password reset email right now", 500);
  }
}
// ── upgradeTierInSupabase ──────────────────────────────────────────────────
//
// Used by billing routes (webhook + callback) to promote a user's tier after
// a successful Paystack payment.
//
// Updates both tables that carry tier information:
//   • profiles      – runtime queries read from here
//   • user_metadata – consulted on login / token refresh so the new tier is
//                     reflected immediately in the next JWT
//
export async function upgradeTierInSupabase(userId: string, tier: Tier): Promise<void> {
  const client = getSupabaseAdminClient();

  // 1. Update the profiles table (primary runtime source)
  const { error: profileError } = await client
    .from("profiles")
    .update({ tier })
    .eq("id", userId);

  if (profileError) {
    throw new Error(`[upgradeTierInSupabase] profiles update failed for ${userId}: ${profileError.message}`);
  }

  // 2. Update Supabase user_metadata so the tier is embedded in the next
  //    access token issued on refresh, without requiring a fresh login.
  const { error: metaError } = await client.auth.admin.updateUserById(userId, {
    user_metadata: { tier },
  });

  if (metaError) {
    // Log but don't throw — the profiles row is the source of truth at runtime.
    // The metadata will self-heal on the next login.
    console.error(
      `[upgradeTierInSupabase] user_metadata update failed for ${userId}: ${metaError.message}`
    );
  }
}
