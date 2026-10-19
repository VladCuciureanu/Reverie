import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.ts";

test("parses valid full config", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
gate:
  block_on: [deep, rem]
  allow_on: [awake, light]
  fallback: block
  timeout_minutes: 480
`;
  const config = parseConfig(yaml);
  assert.deepStrictEqual(config.sleep_tracker, "oura");
  assert.deepStrictEqual(config.engineer, "vlad");
  assert.deepStrictEqual(config.gate.block_on, ["deep", "rem"]);
  assert.deepStrictEqual(config.gate.allow_on, ["awake", "light"]);
  assert.deepStrictEqual(config.gate.fallback, "block");
  assert.deepStrictEqual(config.gate.timeout_minutes, 480);
});

test("applies defaults for missing gate fields", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
`;
  const config = parseConfig(yaml);
  assert.deepStrictEqual(config.gate.block_on, ["deep", "rem"]);
  assert.deepStrictEqual(config.gate.allow_on, ["awake", "light"]);
  assert.deepStrictEqual(config.gate.fallback, "block");
  assert.deepStrictEqual(config.gate.timeout_minutes, 480);
});

test("throws on missing sleep_tracker", () => {
  assert.throws(() => parseConfig("engineer: vlad"), {
    message: "Missing required field: sleep_tracker",
  });
});

test("throws on missing engineer", () => {
  assert.throws(() => parseConfig("sleep_tracker: oura"), {
    message: "Missing required field: engineer",
  });
});

test("throws on invalid sleep state", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
gate:
  block_on: [deep, napping]
`;
  assert.throws(() => parseConfig(yaml), {
    message: "Invalid sleep state: napping",
  });
});

test("parses fallback allow", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
gate:
  fallback: allow
`;
  const config = parseConfig(yaml);
  assert.deepStrictEqual(config.gate.fallback, "allow");
});
