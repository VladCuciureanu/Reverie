import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_GATE, loadConfig, loadSettings, parseConfig } from "../src/config.ts";

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

test("sleep_tracker defaults to oura and engineer is optional", () => {
  const config = parseConfig("gate:\n  fallback: allow\n");
  assert.deepStrictEqual(config.sleep_tracker, "oura");
  assert.deepStrictEqual(config.engineer, undefined);
  assert.deepStrictEqual(config.gate.fallback, "allow");
});

test("throws on an unsupported sleep_tracker", () => {
  assert.throws(() => parseConfig("sleep_tracker: fitbit"), {
    message: "Unsupported sleep_tracker: fitbit (only oura is supported)",
  });
});

test("throws on an empty or non-string engineer", () => {
  for (const engineer of ['""', "42"]) {
    assert.throws(() => parseConfig(`engineer: ${engineer}`), {
      message: "Invalid engineer: expected a non-empty string",
    });
  }
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

test("throws on an invalid fallback", () => {
  for (const fallback of ["alow", "true", "null"]) {
    const yaml = `sleep_tracker: oura\nengineer: vlad\ngate:\n  fallback: ${fallback}\n`;
    assert.throws(() => parseConfig(yaml), { message: /^Invalid fallback: / }, fallback);
  }
});

test("throws on an out-of-range or non-integer timeout_minutes", () => {
  for (const timeout of ["0", "-5", "1.5", '"60"', "abc"]) {
    const yaml = `sleep_tracker: oura\nengineer: vlad\ngate:\n  timeout_minutes: ${timeout}\n`;
    assert.throws(() => parseConfig(yaml), { message: /^Invalid timeout_minutes: / }, timeout);
  }
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
  writeFileSync(path, "sleep_tracker: fitbit\n");
  assert.throws(() => loadConfig(path), { message: /^Unsupported sleep_tracker: fitbit/ });
});

/** A complete environment whose config path doesn't exist, so the defaults apply. */
function baseEnv(t: { after: (fn: () => void) => void }): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    REVERIE_CONFIG: join(dir, "missing.yml"),
    REVERIE_API_TOKEN: "api",
    OURA_TOKEN: "oura",
    GITHUB_TOKEN: "gh",
    REVERIE_ENGINEER: "vlad",
  };
}

test("loadSettings reads a complete environment", (t) => {
  const settings = loadSettings({ ...baseEnv(t), PORT: "9000", REVERIE_DB: "x.db" });
  assert.deepStrictEqual(settings.port, 9000);
  assert.deepStrictEqual(settings.dbPath, "x.db");
  assert.deepStrictEqual(settings.engineer, "vlad");
  assert.deepStrictEqual(settings.gate, DEFAULT_GATE);
  assert.deepStrictEqual(settings.configFound, false);
});

test("loadSettings requires OURA_TOKEN, GITHUB_TOKEN and REVERIE_API_TOKEN", (t) => {
  for (const name of ["OURA_TOKEN", "GITHUB_TOKEN", "REVERIE_API_TOKEN"]) {
    for (const value of [undefined, ""]) {
      const env = { ...baseEnv(t), [name]: value };
      assert.throws(() => loadSettings(env), { message: `${name} must be set` });
    }
  }
});

test("loadSettings rejects a PORT that isn't a valid port number", (t) => {
  for (const port of ["abc", "", "80.5", "-1", "65536", "8000x"]) {
    assert.throws(() => loadSettings({ ...baseEnv(t), PORT: port }), {
      message: `PORT must be an integer from 0 to 65535, got "${port}"`,
    });
  }
});

test("loadSettings takes the engineer from REVERIE_ENGINEER, then the config file", (t) => {
  const env = baseEnv(t);
  const dir = mkdtempSync(join(tmpdir(), "reverie-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, ".reverie.yml");
  writeFileSync(path, "engineer: alice\n");

  assert.deepStrictEqual(loadSettings({ ...env, REVERIE_CONFIG: path }).engineer, "vlad");
  const fromFile = loadSettings({ ...env, REVERIE_CONFIG: path, REVERIE_ENGINEER: undefined });
  assert.deepStrictEqual(fromFile.engineer, "alice");
});

test("loadSettings fails when no engineer is set anywhere", (t) => {
  const env: NodeJS.ProcessEnv = { ...baseEnv(t), REVERIE_ENGINEER: undefined };
  assert.throws(() => loadSettings(env), {
    message: `No engineer set: set REVERIE_ENGINEER or engineer in ${env.REVERIE_CONFIG}`,
  });
});
