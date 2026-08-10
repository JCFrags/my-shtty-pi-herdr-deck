import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentSchemaUrl = new URL("../../../schemas/m3-agent.schema.json", import.meta.url);
const assignmentSchemaUrl = new URL("../../../schemas/m3-assignment.schema.json", import.meta.url);

async function readSchema(url: URL): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;
}

test("M3 schemas are namespaced additive draft schemas", async () => {
  const [agent, assignment] = await Promise.all([readSchema(agentSchemaUrl), readSchema(assignmentSchemaUrl)]);
  assert.equal(agent["$schema"], "https://json-schema.org/draft/2020-12/schema");
  assert.equal(assignment["$schema"], "https://json-schema.org/draft/2020-12/schema");
  assert.match(String(agent["$id"]), /\/m3-agent-v1\.json$/);
  assert.match(String(assignment["$id"]), /\/m3-assignment-v1\.json$/);
  assert.deepEqual(agent["additionalProperties"], false);
  assert.deepEqual(assignment["additionalProperties"], false);
});

test("M3 agent schema covers identity, generation, capability, and liveness bindings", async () => {
  const schema = await readSchema(agentSchemaUrl);
  const required = schema["required"] as string[];
  assert.deepEqual(required, ["version", "agentId", "generation", "kind", "role", "projectId", "workspaceId", "lifecycle", "capabilities", "liveness"]);
  const properties = schema["properties"] as Record<string, unknown>;
  assert.ok(properties["occupant"]);
  assert.ok(properties["parentAgentId"]);
  const capabilities = properties["capabilities"] as Record<string, unknown>;
  assert.deepEqual(capabilities["additionalProperties"], false);
});

test("M3 assignment schema covers exact task/run/agent correlation", async () => {
  const schema = await readSchema(assignmentSchemaUrl);
  const required = schema["required"] as string[];
  for (const field of ["assignmentId", "taskId", "runId", "agentId", "generation", "assignmentGeneration", "piSessionId", "deadline"]) {
    assert.ok(required.includes(field), `missing required field: ${field}`);
  }
  const properties = schema["properties"] as Record<string, Record<string, unknown>>;
  assert.match(String(properties["agentId"]!["pattern"]), /^\^agt_/);
  assert.match(String(properties["taskId"]!["pattern"]), /^\^tsk_/);
  assert.match(String(properties["runId"]!["pattern"]), /^\^run_/);
  assert.match(String(properties["assignmentId"]!["pattern"]), /^\^asg_/);
});

test("M3 schema fixtures reject stale identity and generation values", async () => {
  const [agent, assignment] = await Promise.all([readSchema(agentSchemaUrl), readSchema(assignmentSchemaUrl)]);
  const agentIdPattern = new RegExp(String((agent["properties"] as Record<string, Record<string, string>>)["agentId"]!["pattern"]));
  const assignmentIdPattern = new RegExp(String((assignment["properties"] as Record<string, Record<string, string>>)["assignmentId"]!["pattern"]));
  assert.equal(agentIdPattern.test("agt_01J00000000000000000000000"), true);
  assert.equal(agentIdPattern.test("agt_stale-session"), false);
  assert.equal(assignmentIdPattern.test("asg_01J00000000000000000000000"), true);
  assert.equal(assignmentIdPattern.test("asg_0"), false);
  assert.equal((assignment["properties"] as Record<string, Record<string, Record<string, number>>>)["generation"]!["minimum"], 1);
});
