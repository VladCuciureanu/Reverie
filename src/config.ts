import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
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

export const DEFAULT_GATE: GateConfig = {
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

function validateFallback(fallback: unknown): GateConfig["fallback"] {
  if (fallback !== "allow" && fallback !== "block") {
    throw new Error(`Invalid fallback: ${fallback} (expected allow or block)`);
  }
  return fallback;
}

function validateTimeout(minutes: unknown): number {
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`Invalid timeout_minutes: ${minutes} (expected a positive integer)`);
  }
  return minutes;
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
    block_on: rawGate.block_on ? validateSleepStates(rawGate.block_on) : DEFAULT_GATE.block_on,
    allow_on: rawGate.allow_on ? validateSleepStates(rawGate.allow_on) : DEFAULT_GATE.allow_on,
    fallback:
      rawGate.fallback === undefined ? DEFAULT_GATE.fallback : validateFallback(rawGate.fallback),
    timeout_minutes:
      rawGate.timeout_minutes === undefined
        ? DEFAULT_GATE.timeout_minutes
        : validateTimeout(rawGate.timeout_minutes),
  };

  return {
    sleep_tracker: raw.sleep_tracker,
    engineer: raw.engineer,
    gate,
  };
}

/** Reads and parses a config file. Returns null if the file doesn't exist. */
export function loadConfig(path: string): ReverieConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseConfig(text);
}

/** Everything the service needs at startup, from the environment and the config file. */
export interface Settings {
  engineer: string;
  gate: GateConfig;
  apiToken: string;
  ouraToken: string;
  githubToken: string;
  port: number;
  dbPath: string;
  configPath: string;
  /** False when there is no config file and the defaults apply. */
  configFound: boolean;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

/**
 * Reads the service settings. Throws an Error with a one-line message when
 * the config file is invalid or a required variable is missing or malformed.
 */
export function loadSettings(env: NodeJS.ProcessEnv): Settings {
  const configPath = env.REVERIE_CONFIG ?? ".reverie.yml";
  let config: ReverieConfig | null;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    throw new Error(`Invalid config ${configPath}: ${(err as Error).message}`);
  }
  if (config && config.sleep_tracker !== "oura") {
    throw new Error(`Unsupported sleep_tracker: ${config.sleep_tracker}`);
  }

  const apiToken = requireEnv(env, "REVERIE_API_TOKEN");
  const ouraToken = requireEnv(env, "OURA_TOKEN");
  const githubToken = requireEnv(env, "GITHUB_TOKEN");

  const rawPort = env.PORT ?? "8000";
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got "${rawPort}"`);
  }

  return {
    engineer: env.REVERIE_ENGINEER ?? config?.engineer ?? "engineer",
    gate: config?.gate ?? DEFAULT_GATE,
    apiToken,
    ouraToken,
    githubToken,
    port,
    dbPath: env.REVERIE_DB ?? "reverie.db",
    configPath,
    configFound: config !== null,
  };
}
