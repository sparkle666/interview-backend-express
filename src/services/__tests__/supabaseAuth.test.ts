import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuthResponse, signInWithSupabase, SupabaseAuthError } from "../supabaseAuth";

test("createAuthResponse returns a Supabase-friendly auth payload", () => {
  const result = createAuthResponse({
    userId: "user_123",
    email: "dev@example.com",
    tier: "pro",
  });

  assert.equal(result.userId, "user_123");
  assert.equal(result.email, "dev@example.com");
  assert.equal(result.tier, "pro");
  assert.equal(result.provider, "local");
});

test("signInWithSupabase throws for invalid credentials", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: false,
    json: async () => ({ error: { message: "Invalid login credentials", status: 401 } }),
  }) as unknown as Response) as typeof fetch;

  try {
    await assert.rejects(
      () => signInWithSupabase({ email: "bad@example.com", password: "wrong-password" }),
      (error: unknown) => error instanceof SupabaseAuthError && error.statusCode === 401
    );
  } finally {
    global.fetch = originalFetch;
  }
});
