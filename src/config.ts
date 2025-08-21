import { parse as parseYaml } from "@std/yaml";
import type { SleepState } from "./sleep/types.ts";

export interface GateConfig {
  block_on: SleepState[];
  allow_on: SleepState[];
  fallback: "block" | "allow";
  timeout_minutes: number;
}

export interface ReverieConfig {
  sleep_tracker: string;
  engineer: string;
  gate: GateConfig;
}

const VALID_SLEEP_STATES: SleepState[] = ["awake", "light", "deep", "rem"];

const DEFAULT_GATE: GateConfig = {
  block_on: ["deep", "rem"],
  allow_on: ["awake", "light"],
  fallback: "block",
  timeout_minutes: 480,
};

function validateSleepStates(states: unknown): SleepState[] {
  if (!Array.isArray(states)) {
    throw new Error("Expected array of sleep states");
  }
  for (const s of states) {
    if (!VALID_SLEEP_STATES.includes(s as SleepState)) {
      throw new Error(`Invalid sleep state: ${s}`);
    }
  }
  return states as SleepState[];
}

export function parseConfig(yaml: string): ReverieConfig {
  const raw = parseYaml(yaml) as Record<string, unknown>;

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid config: expected YAML object");
  }
  if (typeof raw.sleep_tracker !== "string" || !raw.sleep_tracker) {
    throw new Error("Missing required field: sleep_tracker");
  }
  if (typeof raw.engineer !== "string" || !raw.engineer) {
    throw new Error("Missing required field: engineer");
  }

  const rawGate = (raw.gate ?? {}) as Record<string, unknown>;

  const gate: GateConfig = {
    block_on: rawGate.block_on
      ? validateSleepStates(rawGate.block_on)
      : DEFAULT_GATE.block_on,
    allow_on: rawGate.allow_on
      ? validateSleepStates(rawGate.allow_on)
      : DEFAULT_GATE.allow_on,
    fallback: rawGate.fallback === "allow" ? "allow" : DEFAULT_GATE.fallback,
    timeout_minutes: typeof rawGate.timeout_minutes === "number"
      ? rawGate.timeout_minutes
      : DEFAULT_GATE.timeout_minutes,
  };

  return {
    sleep_tracker: raw.sleep_tracker,
    engineer: raw.engineer,
    gate,
  };
}
