import type { SleepTracker } from "./tracker.ts";
import type { SleepState, SleepStatus } from "./types.ts";

interface OuraSleepSession {
  type: string;
  bedtime_start: string;
  bedtime_end: string;
  /** One character per 5 minutes from bedtime_start: 1=deep 2=light 3=REM 4=awake. */
  sleep_phase_5_min?: string | null;
}

interface OuraResponse {
  data: OuraSleepSession[];
}

const PHASE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const OURA_PHASE_MAP: Record<string, SleepState> = {
  "1": "deep",
  "2": "light",
  "3": "rem",
  "4": "awake",
};

function isoDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

export class OuraTracker implements SleepTracker {
  private baseUrl: string;
  private token: string;
  private fetchFn: typeof fetch;
  private now: () => Date;

  constructor(options: {
    token: string;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    now?: () => Date;
  }) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? "https://api.ouraring.com";
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async getStatus(_engineer: string): Promise<SleepStatus | null> {
    const now = this.now();
    // Oura files a night under the day it ends, and a session that started
    // before midnight UTC belongs to yesterday's start date, so query a
    // window around today rather than today alone.
    const params = new URLSearchParams({
      start_date: isoDate(new Date(now.getTime() - DAY_MS)),
      end_date: isoDate(new Date(now.getTime() + DAY_MS)),
    });
    const url = `${this.baseUrl}/v2/usercollection/sleep?${params}`;

    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    if (!response.ok) {
      return null;
    }

    const body: OuraResponse = await response.json();
    if (!body.data || body.data.length === 0) {
      return { state: "awake", since: now };
    }

    const latest = body.data.reduce((a, b) =>
      new Date(b.bedtime_start) > new Date(a.bedtime_start) ? b : a,
    );
    const bedtimeEnd = new Date(latest.bedtime_end);

    // If bedtime_end is in the past, the engineer is awake
    if (bedtimeEnd <= now) {
      return { state: "awake", since: bedtimeEnd };
    }

    return currentPhase(latest, now);
  }
}

/**
 * Reads the stage at `now` from the session's 5-minute phase string. Returns
 * null when there is no phase data for the current offset (unknown state).
 */
function currentPhase(
  session: OuraSleepSession,
  now: Date,
): SleepStatus | null {
  const phases = session.sleep_phase_5_min ?? "";
  const start = new Date(session.bedtime_start).getTime();
  const index = Math.floor((now.getTime() - start) / PHASE_MS);
  if (index < 0 || index >= phases.length) return null;

  const state = OURA_PHASE_MAP[phases[index]];
  if (!state) return null;

  let runStart = index;
  while (runStart > 0 && phases[runStart - 1] === phases[index]) runStart--;
  return { state, since: new Date(start + runStart * PHASE_MS) };
}
