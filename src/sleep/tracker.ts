import type { SleepStatus } from "./types.ts";

export interface SleepTracker {
  getStatus(engineer: string): Promise<SleepStatus | null>;
}
