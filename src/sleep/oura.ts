import type { SleepTracker } from "./tracker.ts";
import type { SleepState, SleepStatus } from "./types.ts";

interface OuraSleepSession {
  type: string;
  bedtime_start: string;
  bedtime_end: string;
}

interface OuraResponse {
  data: OuraSleepSession[];
}

const OURA_STATE_MAP: Record<string, SleepState> = {
  "long_sleep": "deep",
  "late_nap": "light",
  "rest": "light",
};

export class OuraTracker implements SleepTracker {
  private baseUrl: string;
  private token: string;
  private fetchFn: typeof fetch;

  constructor(options: {
    token: string;
    baseUrl?: string;
    fetchFn?: typeof fetch;
  }) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.ouraring.com";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getStatus(_engineer: string): Promise<SleepStatus | null> {
    const today = new Date().toISOString().split("T")[0];
    const url = `${this.baseUrl}/v2/usercollection/sleep?start_date=${today}`;

    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      return null;
    }

    const body: OuraResponse = await response.json();
    if (!body.data || body.data.length === 0) {
      return { state: "awake", since: new Date() };
    }

    const latest = body.data[body.data.length - 1];
    const bedtimeEnd = new Date(latest.bedtime_end);

    // If bedtime_end is in the past, the engineer is awake
    if (bedtimeEnd <= new Date()) {
      return { state: "awake", since: bedtimeEnd };
    }

    // Currently in a sleep session
    const state = OURA_STATE_MAP[latest.type] ?? "deep";
    return { state, since: new Date(latest.bedtime_start) };
  }
}
