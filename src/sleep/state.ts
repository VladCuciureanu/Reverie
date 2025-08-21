import type { SleepTracker } from "./tracker.ts";
import type { SleepStatus } from "./types.ts";

interface CacheEntry {
  status: SleepStatus;
  fetchedAt: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class SleepStateCache implements SleepTracker {
  private cache = new Map<string, CacheEntry>();
  private tracker: SleepTracker;
  private ttlMs: number;
  private now: () => number;

  constructor(
    tracker: SleepTracker,
    options?: { ttlMs?: number; now?: () => number },
  ) {
    this.tracker = tracker;
    this.ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options?.now ?? Date.now;
  }

  async getStatus(engineer: string): Promise<SleepStatus | null> {
    const cached = this.cache.get(engineer);
    const now = this.now();

    if (cached && now - cached.fetchedAt < this.ttlMs) {
      return cached.status;
    }

    const status = await this.tracker.getStatus(engineer);
    if (status) {
      this.cache.set(engineer, { status, fetchedAt: now });
    } else {
      this.cache.delete(engineer);
    }

    return status;
  }
}
