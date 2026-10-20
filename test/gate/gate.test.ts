import assert from "node:assert/strict";
import { test } from "node:test";
import type { GateConfig } from "../../src/config.ts";
import { checkGate } from "../../src/gate/gate.ts";
import type { SleepStatus } from "../../src/sleep/types.ts";

const defaultGate: GateConfig = {
  block_on: ["deep", "rem"],
  allow_on: ["awake", "light"],
  fallback: "block",
  timeout_minutes: 480,
};

test("allows deploy when engineer is awake", () => {
  const status: SleepStatus = {
    state: "awake",
    since: new Date("2026-03-24T08:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assert.deepStrictEqual(result.allowed, true);
  assert.deepStrictEqual(result.sleep_state, "awake");
});

test("allows deploy when engineer is in light sleep", () => {
  const status: SleepStatus = {
    state: "light",
    since: new Date("2026-03-24T01:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assert.deepStrictEqual(result.allowed, true);
});

test("blocks deploy when engineer is in deep sleep", () => {
  const status: SleepStatus = {
    state: "deep",
    since: new Date("2026-03-24T02:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assert.deepStrictEqual(result.allowed, false);
  assert.deepStrictEqual(result.sleep_state, "deep");
  assert.deepStrictEqual(result.reason, "Engineer is in DEEP sleep.");
});

test("blocks deploy when engineer is in REM", () => {
  const status: SleepStatus = {
    state: "rem",
    since: new Date("2026-03-24T03:00:00Z"),
  };
  const result = checkGate(status, defaultGate);
  assert.deepStrictEqual(result.allowed, false);
  assert.deepStrictEqual(result.reason, "Engineer is in REM sleep.");
});

test("blocks when status unknown and fallback is block", () => {
  const result = checkGate(null, defaultGate);
  assert.deepStrictEqual(result.allowed, false);
  assert.deepStrictEqual(result.sleep_state, "unknown");
});

test("allows when status unknown and fallback is allow", () => {
  const gate = { ...defaultGate, fallback: "allow" as const };
  const result = checkGate(null, gate);
  assert.deepStrictEqual(result.allowed, true);
  assert.deepStrictEqual(result.sleep_state, "unknown");
});

test("override bypasses gate even during REM", () => {
  const status: SleepStatus = {
    state: "rem",
    since: new Date("2026-03-24T03:00:00Z"),
  };
  const result = checkGate(status, defaultGate, "alice");
  assert.deepStrictEqual(result.allowed, true);
  assert.deepStrictEqual(result.reason, "Gate overridden by alice.");
});

test("applies fallback to states in neither block_on nor allow_on", () => {
  const status: SleepStatus = {
    state: "light",
    since: new Date("2026-03-24T01:00:00Z"),
  };
  const gate: GateConfig = {
    ...defaultGate,
    block_on: ["deep"],
    allow_on: ["awake"],
  };
  const blocked = checkGate(status, gate);
  assert.deepStrictEqual(blocked.allowed, false);
  assert.deepStrictEqual(blocked.sleep_state, "light");

  const allowed = checkGate(status, { ...gate, fallback: "allow" });
  assert.deepStrictEqual(allowed.allowed, true);
});

test("block_on wins over allow_on", () => {
  const status: SleepStatus = {
    state: "light",
    since: new Date("2026-03-24T01:00:00Z"),
  };
  const gate: GateConfig = {
    ...defaultGate,
    block_on: ["light"],
    allow_on: ["light"],
  };
  assert.deepStrictEqual(checkGate(status, gate).allowed, false);
});
