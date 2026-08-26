import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the production broker constructs one configured scheduler authority", async () => {
  const source = await readFile(
    new URL("../../src/broker/broker.js", import.meta.url),
    "utf8",
  );
  const constructions = source.match(/new DeterministicScheduler\(/gu) ?? [];
  assert.equal(constructions.length, 1);
  assert.match(
    source,
    /new DeterministicScheduler\(options\.schedulerLimits\)/u,
  );
});

test("production startup passes scheduler configuration into the broker", async () => {
  const source = await readFile(
    new URL("../../src/cli/main.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /schedulerLimits:\s*brokerConfig\.scheduler/u);
});
