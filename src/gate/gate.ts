import type { GateConfig } from "../config.ts";
import type { SleepStatus } from "../sleep/types.ts";

export interface GateResult {
  allowed: boolean;
  reason: string;
  sleep_state: string;
  retry_after_seconds: number | null;
}

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
      retry_after_seconds: allowed ? null : 300,
    };
  }

  if (config.block_on.includes(status.state)) {
    return {
      allowed: false,
      reason: `Engineer is in ${status.state.toUpperCase()} sleep.`,
      sleep_state: status.state,
      retry_after_seconds: 1800,
    };
  }

  return {
    allowed: true,
    reason: `Engineer is ${status.state}. Deploy allowed.`,
    sleep_state: status.state,
    retry_after_seconds: null,
  };
}
