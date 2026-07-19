// src/services/usageTracker.ts
//
// Supabase-backed usage tracking for per-tier monthly limits.

import { createClient } from "@supabase/supabase-js";
import { Tier } from "../types";

const TIER_LIMITS: Record<Tier, number> = {
  free: Number(process.env.TIER_FREE_MONTHLY_LIMIT) || 3,
  starter: Number(process.env.TIER_STARTER_MONTHLY_LIMIT) || 20,
  pro: Number(process.env.TIER_PRO_MONTHLY_LIMIT) || 100,
  legend: Number(process.env.TIER_LEGEND_MONTHLY_LIMIT) || 200,
};

interface UserUsage {
  count: number;
  date: string;
}

function thisMonth(): string {
  return new Date().toISOString().slice(0, 7); // "2026-07"
}

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || (!anonKey && !serviceRoleKey)) {
    throw new Error("Supabase auth not configured");
  }

  return { url, key: serviceRoleKey || anonKey! };
}

function getSupabaseClient() {
  const { url, key } = getSupabaseConfig();

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function getUsageRow(userId: string): Promise<UserUsage | null> {
  const client = getSupabaseClient();
  const date = thisMonth();

  const { data, error } = await client
    .from("user_usage")
    .select("count, usage_month")
    .eq("user_id", userId)
    .eq("usage_month", date)
    .maybeSingle();

  if (error) {
    console.warn("[usageTracker] failed to load usage", error.message);
    return null;
  }

  if (!data) {
    return { count: 0, date };
  }

  return {
    count: Number(data.count || 0),
    date: String(data.usage_month || date),
  };
}

export const usageTracker = {
  async getUsage(userId: string): Promise<UserUsage> {
    const usage = await getUsageRow(userId);
    return usage || { count: 0, date: thisMonth() };
  },

  async getCount(userId: string): Promise<number> {
    const usage = await this.getUsage(userId);
    return usage.count;
  },

  getLimit(tier: Tier): number {
    return TIER_LIMITS[tier];
  },

  async canUse(userId: string, tier: Tier): Promise<boolean> {
    const count = await this.getCount(userId);
    return count < this.getLimit(tier);
  },

  async increment(userId: string): Promise<void> {
    const client = getSupabaseClient();
    const date = thisMonth();

    const { data, error } = await client
      .from("user_usage")
      .select("count")
      .eq("user_id", userId)
      .eq("usage_month", date)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      console.warn("[usageTracker] failed to read usage before increment", error.message);
      return;
    }

    const nextCount = (Number(data?.count || 0) + 1).toString();

    const { error: upsertError } = await client.from("user_usage").upsert(
      {
        user_id: userId,
        usage_month: date,
        count: nextCount,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,usage_month" }
    );

    if (upsertError) {
      console.warn("[usageTracker] failed to persist usage", upsertError.message);
    }
  },

  // ── Reset usage for the current month ──────────────────────────────────────
  // Called after a successful payment (renewal or upgrade) so the user gets
  // a fresh quota immediately without waiting for next month.
  async reset(userId: string): Promise<void> {
    const client = getSupabaseClient();
    const date = thisMonth();

    const { error } = await client.from("user_usage").upsert(
      {
        user_id: userId,
        usage_month: date,
        count: "0",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,usage_month" }
    );

    if (error) {
      console.warn("[usageTracker] failed to reset usage", error.message);
    } else {
      console.log(`[usageTracker] Reset usage for user ${userId} (month: ${date})`);
    }
  },

  async summary(userId: string, tier: Tier) {
    const used = await this.getCount(userId);
    const limit = this.getLimit(tier);
    return {
      used,
      limit,
      tier,
      remaining: Math.max(0, limit - used),
    };
  },
};