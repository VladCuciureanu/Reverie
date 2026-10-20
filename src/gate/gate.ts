import type { GateConfig } from "../config.ts";
import type { SleepStatus } from "../sleep/types.ts";

export interface GateResult {
  allowed: boolean;
  reason: string;
  sleep_state: string;
  retry_after_seconds: number | null;
}

// retry_after_seconds is only a hint for callers: blocked deploys are queued
// and the wake watcher re-dispatches them itself, so nothing needs to retry.

/** Unknown stage: failed Oura reads aren't cached, so a check soon after may succeed. */
const RETRY_UNKNOWN_SECONDS = 5 * 60;
/** Blocked by sleep: a deep or REM stretch usually lasts tens of minutes. */
const RETRY_ASLEEP_SECONDS = 30 * 60;

export function checkGate(
  status: SleepStatus | null,
  config: GateConfig,
  overrideBy?: string,
): GateResult {
  if (overrideBy) {
    return {
      allowed: true,
      reason: `Gate overridden by ${overrideBy}.`,
      sleep_state: status?.state ?? "unknown",
      retry_after_seconds: null,
    };
  }

  if (!status) {
    const allowed = config.fallback === "allow";
    return {
      allowed,
      reason: allowed
        ? "Sleep state unknown. Fallback: allow."
        : "Sleep state unknown. Fallback: block.",
      sleep_state: "unknown",
      retry_after_seconds: allowed ? null : RETRY_UNKNOWN_SECONDS,
    };
  }

  if (config.block_on.includes(status.state)) {
    return {
      allowed: false,
      reason: `Engineer is in ${status.state.toUpperCase()} sleep.`,
      sleep_state: status.state,
      retry_after_seconds: RETRY_ASLEEP_SECONDS,
    };
  }

  if (!config.allow_on.includes(status.state)) {
    const allowed = config.fallback === "allow";
    return {
      allowed,
      reason: `Engineer is ${status.state}, which is not in allow_on. Fallback: ${config.fallback}.`,
      sleep_state: status.state,
      retry_after_seconds: allowed ? null : RETRY_ASLEEP_SECONDS,
    };
  }

  return {
    allowed: true,
    reason: `Engineer is ${status.state}. Deploy allowed.`,
    sleep_state: status.state,
    retry_after_seconds: null,
  };
}
