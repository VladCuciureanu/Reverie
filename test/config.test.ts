import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_GATE, loadConfig, parseConfig } from "../src/config.ts";

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

test("loadConfig reads and parses a config file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, ".reverie.yml");
  writeFileSync(
    path,
    "sleep_tracker: oura\nengineer: vlad\ngate:\n  fallback: allow\n  timeout_minutes: 60\n",
  );

  const config = loadConfig(path);
  assert.deepStrictEqual(config?.engineer, "vlad");
  assert.deepStrictEqual(config?.gate.fallback, "allow");
  assert.deepStrictEqual(config?.gate.timeout_minutes, 60);
  assert.deepStrictEqual(config?.gate.block_on, DEFAULT_GATE.block_on);
});

test("loadConfig returns null when the file is absent", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepStrictEqual(loadConfig(join(dir, "missing.yml")), null);
});

test("loadConfig throws on an invalid file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, ".reverie.yml");
  writeFileSync(path, "engineer: vlad\n");
  assert.throws(() => loadConfig(path), {
    message: "Missing required field: sleep_tracker",
  });
});
