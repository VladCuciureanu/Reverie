import { assertEquals, assertThrows } from "@std/assert";
import { parseConfig } from "../src/config.ts";

Deno.test("parses valid full config", () => {
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
  assertEquals(config.sleep_tracker, "oura");
  assertEquals(config.engineer, "vlad");
  assertEquals(config.gate.block_on, ["deep", "rem"]);
  assertEquals(config.gate.allow_on, ["awake", "light"]);
  assertEquals(config.gate.fallback, "block");
  assertEquals(config.gate.timeout_minutes, 480);
});

Deno.test("applies defaults for missing gate fields", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
`;
  const config = parseConfig(yaml);
  assertEquals(config.gate.block_on, ["deep", "rem"]);
  assertEquals(config.gate.allow_on, ["awake", "light"]);
  assertEquals(config.gate.fallback, "block");
  assertEquals(config.gate.timeout_minutes, 480);
});

Deno.test("throws on missing sleep_tracker", () => {
  assertThrows(
    () => parseConfig("engineer: vlad"),
    Error,
    "Missing required field: sleep_tracker",
  );
});

Deno.test("throws on missing engineer", () => {
  assertThrows(
    () => parseConfig("sleep_tracker: oura"),
    Error,
    "Missing required field: engineer",
  );
});

Deno.test("throws on invalid sleep state", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
gate:
  block_on: [deep, napping]
`;
  assertThrows(() => parseConfig(yaml), Error, "Invalid sleep state: napping");
});

Deno.test("parses fallback allow", () => {
  const yaml = `
sleep_tracker: oura
engineer: vlad
gate:
  fallback: allow
`;
  const config = parseConfig(yaml);
  assertEquals(config.gate.fallback, "allow");
});
