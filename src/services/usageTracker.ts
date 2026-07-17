// src/services/usageTracker.ts
//
// In-memory implementation — good enough to start.
// For production, replace the Map with Redis or a database table.
// The interface stays the same so swapping is trivial.

import { Tier } from "../types";

const TIER_LIMITS: Record<Tier, number> = {
  free:      Number(process.env.TIER_FREE_DAILY_LIMIT)      || 3,
  starter:   Number(process.env.TIER_STARTER_DAILY_LIMIT)   || 20,
  pro:       Number(process.env.TIER_PRO_DAILY_LIMIT)        || 100,
  unlimited: Number(process.env.TIER_UNLIMITED_DAILY_LIMIT)  || 999_999,
};

interface UserUsage {
  count: number;
  /** ISO date string: YYYY-MM-DD */
  date: string;
}

// userId → usage
const store = new Map<string, UserUsage>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export const usageTracker = {
  /** Returns current usage for today */
  getUsage(userId: string): UserUsage {
    const entry = store.get(userId);
    if (!entry || entry.date !== today()) {
      return { count: 0, date: today() };
    }
    return entry;
  },

  /** Returns how many solutions the user has used today */
  getCount(userId: string): number {
    return this.getUsage(userId).count;
  },

  /** Returns the daily limit for a tier */
  getLimit(tier: Tier): number {
    return TIER_LIMITS[tier];
  },

  /** Returns true if the user is under their daily limit */
  canUse(userId: string, tier: Tier): boolean {
    return this.getCount(userId) < this.getLimit(tier);
  },

  /** Increments the counter. Call AFTER a successful AI response. */
  increment(userId: string): void {
    const t = today();
    const entry = store.get(userId);
    if (!entry || entry.date !== t) {
      store.set(userId, { count: 1, date: t });
    } else {
      store.set(userId, { count: entry.count + 1, date: t });
    }
  },

  /** Summary object for API responses */
  summary(userId: string, tier: Tier) {
    const used  = this.getCount(userId);
    const limit = this.getLimit(tier);
    return {
      used,
      limit,
      tier,
      remaining: Math.max(0, limit - used),
    };
  },
};
