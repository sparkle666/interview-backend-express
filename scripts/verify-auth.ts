import assert from "node:assert/strict";
import { signInWithSupabase, SupabaseAuthError } from "../src/services/supabaseAuth";

async function main() {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";

  const originalFetch = global.fetch;
  global.fetch = (async () => ({
    ok: false,
    json: async () => ({ error: { message: "Invalid login credentials", status: 401 } }),
  })) as typeof fetch;

  try {
    await assert.rejects(
      () => signInWithSupabase({ email: "bad@example.com", password: "wrong-password" }),
      (error: unknown) => error instanceof SupabaseAuthError && error.statusCode === 401
    );
    console.log("Auth verification passed: invalid credentials fail with 401");
  } finally {
    global.fetch = originalFetch;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
