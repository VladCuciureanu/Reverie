import { assertEquals } from "@std/assert";
import { checkGate } from "../../src/gate/gate.ts";
import type { GateConfig } from "../../src/config.ts";
import type { SleepStatus } from "../../src/sleep/types.ts";

const defaultGate: GateConfig = {
  block_on: ["deep", "rem"],
  allow_on: ["awake", "light"],
  fallback: "block",
  timeout_minutes: 480,
};

Deno.test("allows deploy when engineer is awake", () => {
  const status: SleepStatus = {
    state: "awake",
    since: new Date("2026-03-24T08:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assertEquals(result.allowed, true);
  assertEquals(result.sleep_state, "awake");
});

Deno.test("allows deploy when engineer is in light sleep", () => {
  const status: SleepStatus = {
    state: "light",
    since: new Date("2026-03-24T01:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assertEquals(result.allowed, true);
});

Deno.test("blocks deploy when engineer is in deep sleep", () => {
  const status: SleepStatus = {
    state: "deep",
    since: new Date("2026-03-24T02:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assertEquals(result.allowed, false);
  assertEquals(result.sleep_state, "deep");
  assertEquals(result.reason, "Engineer is in DEEP sleep.");
});

Deno.test("blocks deploy when engineer is in REM", () => {
  const status: SleepStatus = {
    state: "rem",
    since: new Date("2026-03-24T03:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assertEquals(result.allowed, false);
  assertEquals(result.reason, "Engineer is in REM sleep.");
});

Deno.test("blocks when status unknown and fallback is block", () => {
  const result = checkGate(null, defaultGate);
  assertEquals(result.allowed, false);
  assertEquals(result.sleep_state, "unknown");
});

Deno.test("allows when status unknown and fallback is allow", () => {
  const gate = { ...defaultGate, fallback: "allow" as const };
  const result = checkGate(null, gate);
  assertEquals(result.allowed, true);
  assertEquals(result.sleep_state, "unknown");
});

Deno.test("override bypasses gate even during REM", () => {
  const status: SleepStatus = {
    state: "rem",
    since: new Date("2026-03-24T03:00:00Z"),
  };
  const result = checkGate(status, defaultGate, "alice");
  assertEquals(result.allowed, true);
  assertEquals(result.reason, "Gate overridden by alice.");
});
