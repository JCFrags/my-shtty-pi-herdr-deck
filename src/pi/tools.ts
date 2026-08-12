import {
  boundedSecretFree,
  DEFAULT_PARENT_TOOL_LIMITS,
  ParentToolService,
  type ParentToolName,
  type ParentToolRequest,
  type ParentToolResponse,
  type ToolPrincipal,
} from "./parent-tools.js";
import {
  isParentToolRequest,
  PARENT_TOOL_NAMES,
} from "./parent-tool-schema.js";
import type { PiAdapter } from "./adapter.js";
import type { CorrelationState } from "./correlation.js";
import type { PiBrokerClient } from "./broker-client.js";
import type { PiApiLike, PiContextLike } from "./types.js";

const MAX_BODY_BYTES = 262_144;
const MAX_TEXT_BYTES = 16_384;
const boundedString = (max: number) => ({
  type: "string",
  minLength: 1,
  maxLength: max,
});
const resultItemSchemas: Record<string, unknown> = {
  findings: {
    type: "object",
    additionalProperties: false,
    required: ["severity", "title", "description", "evidence", "resolved"],
    properties: {
      severity: {
        type: "string",
        enum: ["info", "low", "medium", "high", "critical"],
      },
      title: boundedString(512),
      description: boundedString(8192),
      evidence: { type: "array", maxItems: 32, items: boundedString(4096) },
      resolved: { type: "boolean" },
    },
  },
  changedFiles: {
    type: "object",
    additionalProperties: false,
    required: ["path", "change"],
    properties: {
      path: boundedString(4096),
      change: {
        type: "string",
        enum: ["added", "modified", "deleted", "renamed", "unknown"],
      },
      previousPath: { type: ["string", "null"], maxLength: 4096 },
    },
  },
  commandsRun: {
    type: "object",
    additionalProperties: false,
    required: ["command", "exitCode", "outcome"],
    properties: {
      command: boundedString(8192),
      exitCode: { type: ["integer", "null"], minimum: 0, maximum: 255 },
      outcome: {
        type: "string",
        enum: ["passed", "failed", "cancelled", "unknown"],
      },
    },
  },
  tests: {
    type: "object",
    additionalProperties: false,
    required: [
      "name",
      "command",
      "status",
      "passed",
      "failed",
      "skipped",
      "evidence",
    ],
    properties: {
      name: boundedString(512),
      command: { type: ["string", "null"], maxLength: 8192 },
      status: {
        type: "string",
        enum: ["passed", "failed", "cancelled", "unknown"],
      },
      passed: { type: ["integer", "null"], minimum: 0 },
      failed: { type: ["integer", "null"], minimum: 0 },
      skipped: { type: ["integer", "null"], minimum: 0 },
      evidence: { type: ["string", "null"], maxLength: 4096 },
    },
  },
  commits: {
    type: "object",
    additionalProperties: false,
    required: ["sha", "subject"],
    properties: {
      sha: { type: "string", pattern: "^[0-9a-fA-F]{7,64}$" },
      subject: boundedString(1024),
    },
  },
  artifacts: {
    type: "object",
    additionalProperties: false,
    required: ["kind", "path", "description", "mediaType"],
    properties: {
      kind: {
        type: "string",
        enum: ["text", "json", "patch", "log", "report", "other"],
      },
      path: boundedString(4096),
      description: boundedString(1024),
      mediaType: boundedString(128),
    },
  },
  unresolved: {
    type: "object",
    additionalProperties: false,
    required: ["title", "description", "blocking"],
    properties: {
      title: boundedString(512),
      description: boundedString(8192),
      blocking: { type: "boolean" },
    },
  },
  questions: {
    type: "object",
    additionalProperties: false,
    required: ["questionId", "summary", "answered"],
    properties: {
      questionId: { type: "string", pattern: "^qst_[0-9A-HJKMNP-TV-Z]{26}$" },
      summary: boundedString(1024),
      answered: { type: "boolean" },
    },
  },
};
const resultSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "status",
    "summary",
    "findings",
    "changedFiles",
    "commandsRun",
    "tests",
    "commits",
    "artifacts",
    "unresolved",
    "questions",
    "recommendedNextAction",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    status: { type: "string", enum: ["succeeded", "failed", "cancelled"] },
    summary: { type: "string", minLength: 1, maxLength: 65_536 },
    findings: {
      type: "array",
      maxItems: 256,
      items: resultItemSchemas.findings,
    },
    changedFiles: {
      type: "array",
      maxItems: 4096,
      items: resultItemSchemas.changedFiles,
    },
    commandsRun: {
      type: "array",
      maxItems: 256,
      items: resultItemSchemas.commandsRun,
    },
    tests: { type: "array", maxItems: 256, items: resultItemSchemas.tests },
    commits: { type: "array", maxItems: 64, items: resultItemSchemas.commits },
    artifacts: {
      type: "array",
      maxItems: 128,
      items: resultItemSchemas.artifacts,
    },
    unresolved: {
      type: "array",
      maxItems: 128,
      items: resultItemSchemas.unresolved,
    },
    questions: {
      type: "array",
      maxItems: 64,
      items: resultItemSchemas.questions,
    },
    recommendedNextAction: { type: ["string", "null"], maxLength: 8_192 },
  },
};
const questionSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "prompt",
    "context",
    "options",
    "allowFreeform",
    "defaultOptionId",
    "timeoutMs",
  ],
  properties: {
    schemaVersion: { type: "integer", const: 1 },
    prompt: { type: "string", minLength: 1, maxLength: 16_384 },
    context: { type: ["string", "null"], maxLength: 16_384 },
    options: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "description"],
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,32}$" },
          label: { type: "string", minLength: 1, maxLength: 1_024 },
          description: { type: ["string", "null"], maxLength: 4_096 },
        },
      },
    },
    allowFreeform: { type: "boolean" },
    defaultOptionId: {
      type: ["string", "null"],
      pattern: "^[A-Za-z0-9_-]{1,32}$",
    },
    timeoutMs: { type: "integer", minimum: 10_000, maximum: 86_400_000 },
  },
  allOf: [
    {
      if: {
        properties: {
          allowFreeform: { const: false },
          options: { maxItems: 0 },
        },
      },
      then: false,
    },
  ],
};
const parentInputKeys: Readonly<Record<ParentToolName, readonly string[]>> =
  Object.freeze({
    delegate: [
      "mode",
      "title",
      "steps",
      "wait",
      "waitUntil",
      "timeoutMs",
      "failureMode",
      "dryRun",
    ],
    agent_spawn: [
      "task",
      "profileId",
      "project",
      "isolation",
      "budget",
      "wait",
    ],
    agent_list: [
      "ids",
      "managed",
      "state",
      "profileId",
      "taskId",
      "workspaceId",
      "connected",
      "include",
      "maxBytes",
      "cursor",
      "limit",
    ],
    agent_get: ["agentId", "include", "maxBytes"],
    agent_prompt: [
      "agentId",
      "message",
      "delivery",
      "timeoutMs",
      "createTask",
      "task",
      "profileId",
      "project",
      "isolation",
      "budget",
    ],
    agent_steer: [
      "agentId",
      "message",
      "delivery",
      "runId",
      "assignmentGeneration",
    ],
    agent_ask: ["agentId", "message", "followUps", "timeoutMs"],
    agent_wait: ["agentId", "taskId", "runId", "until", "timeoutMs"],
    coordination_wait: [
      "kind",
      "targetId",
      "until",
      "durationMs",
      "startedAt",
      "timeoutMs",
      "pollMs",
    ],
    coordination_signal: ["targetId"],
    group_create: ["name", "agentIds"],
    group_list: [],
    group_get: ["groupId"],
    group_wait: ["groupId", "until", "mode", "timeoutMs"],
    group_stop: ["groupId", "reason", "force"],
    group_close: ["groupId", "reason", "confirm"],
    agent_result: ["taskId", "resultId", "include", "maxBytes"],
    agent_answer: ["questionId", "answer"],
    agent_interrupt: ["agentId", "runId", "assignmentGeneration", "reason"],
    agent_stop: ["agentId", "runId", "assignmentGeneration", "reason", "force"],
    agent_close: [
      "agentId",
      "runId",
      "assignmentGeneration",
      "reason",
      "confirm",
    ],
    task_list: [
      "state",
      "profileId",
      "workspaceId",
      "include",
      "maxBytes",
      "cursor",
      "limit",
    ],
    task_get: ["taskId", "include", "maxBytes"],
    task_collect: ["taskIds", "select", "maxBytes"],
    task_cancel: ["taskId", "reason", "cascade"],
  });
function validateNested(value: unknown, depth = 0): void {
  if (depth > 6) throw new Error("LIMIT_EXCEEDED");
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      throw new Error("INVALID_REQUEST");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) throw new Error("LIMIT_EXCEEDED");
    for (const item of value) validateNested(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 32) throw new Error("LIMIT_EXCEEDED");
    for (const [key, item] of entries) {
      if (
        Buffer.byteLength(key, "utf8") > 256 ||
        /(?:token|secret|password|cookie|credential|private.?key|api.?key)/iu.test(
          key,
        )
      )
        throw new Error("INVALID_REQUEST");
      validateNested(item, depth + 1);
    }
  }
}
const parentRequired: Readonly<
  Partial<Record<ParentToolName, readonly string[]>>
> = Object.freeze({
  delegate: [
    "mode",
    "title",
    "steps",
    "wait",
    "waitUntil",
    "timeoutMs",
    "failureMode",
    "dryRun",
  ],
  agent_spawn: ["task", "profileId", "project", "isolation", "budget", "wait"],
  agent_get: ["agentId"],
  agent_prompt: ["agentId", "message", "delivery", "timeoutMs"],
  agent_steer: ["agentId", "message", "delivery"],
  agent_ask: ["agentId", "message", "timeoutMs"],
  agent_wait: ["agentId", "taskId", "runId", "until", "timeoutMs"],
  coordination_wait: ["kind", "timeoutMs"],
  coordination_signal: ["targetId"],
  group_create: ["name", "agentIds"],
  group_get: ["groupId"],
  group_wait: ["groupId", "until", "mode", "timeoutMs"],
  group_stop: ["groupId", "reason"],
  group_close: ["groupId", "confirm"],
  agent_result: ["taskId"],
  agent_answer: ["questionId", "answer"],
  agent_interrupt: ["agentId"],
  agent_stop: ["agentId", "reason"],
  agent_close: ["agentId", "confirm"],
  task_get: ["taskId"],
  task_collect: ["taskIds"],
  task_cancel: ["taskId", "reason", "cascade"],
});
function assertInputString(
  value: unknown,
  max = MAX_TEXT_BYTES,
  nonempty = true,
): asserts value is string {
  if (
    typeof value !== "string" ||
    (nonempty && value.length === 0) ||
    Buffer.byteLength(value, "utf8") > max ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new Error("INVALID_REQUEST");
}
function assertExactObject(
  value: unknown,
  keys: readonly string[],
  required: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(object, key))
  )
    throw new Error("INVALID_REQUEST");
}
function validateExactNested(input: Record<string, unknown>): void {
  const arrayFields = new Set([
    "ids",
    "taskIds",
    "include",
    "select",
    "agentIds",
    "followUps",
  ]);
  const stringFields = new Set([
    "title",
    "parentAgentId",
    "agentId",
    "taskId",
    "runId",
    "questionId",
    "resultId",
    "profileId",
    "workspaceId",
    "message",
    "reason",
    "cursor",
    "name",
    "groupId",
    "targetId",
    "kind",
    "startedAt",
  ]);
  for (const [key, value] of Object.entries(input)) {
    if (arrayFields.has(key)) {
      if (
        !Array.isArray(value) ||
        value.length > 64 ||
        value.some((item) => {
          try {
            assertInputString(item, key === "followUps" ? MAX_TEXT_BYTES : 256);
            return false;
          } catch {
            return true;
          }
        })
      )
        throw new Error("INVALID_REQUEST");
      const allowed =
        key === "include"
          ? [
              "capabilities",
              "runHistory",
              "auditSummary",
              "dependencies",
              "runs",
              "blockers",
              "resultValidation",
              "worktree",
              "budgets",
            ]
          : key === "select"
            ? ["summary", "status", "result"]
            : undefined;
      if (allowed && value.some((item) => !allowed.includes(item as string)))
        throw new Error("INVALID_REQUEST");
      continue;
    }
    if (["task", "project", "isolation", "budget", "answer"].includes(key)) {
      if (key === "task") {
        assertExactObject(
          value,
          ["title", "objective", "constraints"],
          ["title", "objective"],
        );
        assertInputString(value.title);
        assertInputString(value.objective);
        if (
          value.constraints !== undefined &&
          (!Array.isArray(value.constraints) ||
            value.constraints.length > 64 ||
            value.constraints.some((item) => {
              try {
                assertInputString(item);
                return false;
              } catch {
                return true;
              }
            }))
        )
          throw new Error("INVALID_REQUEST");
      } else if (key === "project") {
        assertExactObject(value, ["cwd"], ["cwd"]);
        assertInputString(value.cwd, 4096);
      } else if (key === "isolation") {
        assertExactObject(value, ["mode"], ["mode"]);
        assertInputString(value.mode, 64);
        if (!["shared-readonly", "worktree"].includes(value.mode))
          throw new Error("INVALID_REQUEST");
      } else if (key === "budget") {
        assertExactObject(value, ["wallTimeMs"], ["wallTimeMs"]);
        if (
          !Number.isSafeInteger(value.wallTimeMs) ||
          (value.wallTimeMs as number) < 1 ||
          (value.wallTimeMs as number) > 86_400_000
        )
          throw new Error("INVALID_REQUEST");
      } else {
        assertExactObject(value, ["optionId", "text"], ["optionId", "text"]);
        assertInputString(value.optionId, 256);
        if (value.text !== null) assertInputString(value.text, MAX_TEXT_BYTES);
      }
      continue;
    }
    if (key === "steps") {
      if (!Array.isArray(value) || value.length < 1 || value.length > 32)
        throw new Error("INVALID_REQUEST");
      for (const step of value) {
        assertExactObject(
          step,
          [
            "key",
            "profileId",
            "title",
            "objective",
            "dependsOn",
            "constraints",
          ],
          ["key", "profileId", "title", "objective"],
        );
        assertInputString(step.key, 256);
        assertInputString(step.profileId, 256);
        assertInputString(step.title);
        assertInputString(step.objective);
        if (
          step.constraints !== undefined &&
          (!Array.isArray(step.constraints) ||
            step.constraints.length > 64 ||
            step.constraints.some((item) => {
              try {
                assertInputString(item, 8192);
                return false;
              } catch {
                return true;
              }
            }))
        )
          throw new Error("INVALID_REQUEST");
        if (
          step.dependsOn !== undefined &&
          (!Array.isArray(step.dependsOn) ||
            step.dependsOn.length > 32 ||
            step.dependsOn.some((item) => {
              try {
                assertInputString(item, 256);
                return false;
              } catch {
                return true;
              }
            }))
        )
          throw new Error("INVALID_REQUEST");
      }
      continue;
    }
    if (stringFields.has(key)) {
      assertInputString(value, key === "cursor" ? 256 : MAX_TEXT_BYTES);
      continue;
    }
    if (
      [
        "wait",
        "dryRun",
        "managed",
        "connected",
        "force",
        "confirm",
        "createTask",
        "cascade",
      ].includes(key)
    ) {
      if (typeof value !== "boolean") throw new Error("INVALID_REQUEST");
      continue;
    }
    if (
      [
        "timeoutMs",
        "maxBytes",
        "limit",
        "assignmentGeneration",
        "durationMs",
        "pollMs",
      ].includes(key)
    ) {
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (key === "timeoutMs" && (value as number) > 1_800_000) ||
        (key === "maxBytes" && (value as number) > 262_144) ||
        (key === "limit" && (value as number) > 500)
      )
        throw new Error("INVALID_REQUEST");
      continue;
    }
    if (key === "state") {
      const values = Array.isArray(value) ? value : [value];
      if (
        values.some(
          (item) =>
            ![
              "queued",
              "provisioning",
              "running",
              "blocked",
              "succeeded",
              "failed",
              "cancelled",
              "timed_out",
              "lost",
              "idle",
              "working",
              "connected",
              "disconnected",
            ].includes(item as string),
        )
      )
        throw new Error("INVALID_REQUEST");
      continue;
    }
  }
}
function validateParentInput(
  tool: ParentToolName,
  input: Record<string, unknown>,
): void {
  const keys = new Set(parentInputKeys[tool]);
  if (
    Object.keys(input).some((key) => !keys.has(key)) ||
    (parentRequired[tool] ?? []).some((key) => !Object.hasOwn(input, key))
  )
    throw new Error("INVALID_REQUEST");
  validateExactNested(input);
  for (const [key, value] of Object.entries(input)) {
    if (
      [
        "wait",
        "dryRun",
        "managed",
        "connected",
        "force",
        "confirm",
        "createTask",
        "cascade",
      ].includes(key) &&
      typeof value !== "boolean"
    )
      throw new Error("INVALID_REQUEST");
    if (
      [
        "timeoutMs",
        "maxBytes",
        "limit",
        "assignmentGeneration",
        "durationMs",
        "pollMs",
      ].includes(key) &&
      (!Number.isSafeInteger(value) ||
        (value as number) < 1 ||
        (key === "timeoutMs" &&
          (value as number) >
            (tool === "agent_wait"
              ? 30_000
              : tool === "agent_ask"
                ? 120_000
                : 1_800_000)) ||
        (key === "maxBytes" && (value as number) > 262_144) ||
        (key === "limit" && (value as number) > 500) ||
        (key === "durationMs" && (value as number) > 86_400_000) ||
        (key === "pollMs" && (value as number) > 60_000))
    )
      throw new Error("INVALID_REQUEST");
    if (
      [
        "ids",
        "taskIds",
        "include",
        "select",
        "steps",
        "waitUntil",
        "until",
        "agentIds",
        "followUps",
      ].includes(key) &&
      !Array.isArray(value)
    )
      throw new Error("INVALID_REQUEST");
    if (key === "followUps" && (value as unknown[]).length > 3)
      throw new Error("LIMIT_EXCEEDED");
    if (
      key === "agentIds" &&
      ((value as unknown[]).length < 1 || (value as unknown[]).length > 64)
    )
      throw new Error("LIMIT_EXCEEDED");
    if (key === "steps" && (value as unknown[]).length > 32)
      throw new Error("LIMIT_EXCEEDED");
    if (key === "task") {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.hasOwn(value, "title") ||
        !Object.hasOwn(value, "objective")
      )
        throw new Error("INVALID_REQUEST");
    }
    if (key === "answer") {
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "optionId") ||
        !Object.hasOwn(value, "text") ||
        typeof (value as Record<string, unknown>).optionId !== "string" ||
        ((value as Record<string, unknown>).text !== null &&
          typeof (value as Record<string, unknown>).text !== "string")
      )
        throw new Error("INVALID_REQUEST");
    }
    if (
      key === "mode" &&
      tool !== "group_wait" &&
      !["single", "parallel", "chain", "dag", "implement_review_fix"].includes(
        value as string,
      )
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "delivery" &&
      !["normal", "steer", "follow_up"].includes(value as string)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "kind" &&
      ![
        "timer",
        "signal",
        "agent",
        "task",
        "result",
        "question",
        "group",
      ].includes(value as string)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "mode" &&
      tool === "group_wait" &&
      !["all", "any"].includes(value as string)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "failureMode" &&
      !["fail_fast", "collect_all"].includes(value as string)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "isolation" &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((item) => !["mode"].includes(item)) ||
        !["shared-readonly", "worktree"].includes(
          (value as Record<string, unknown>).mode as string,
        ))
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "project" &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).cwd !== "string")
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "budget" &&
      (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !Number.isSafeInteger((value as Record<string, unknown>).wallTimeMs))
    )
      throw new Error("INVALID_REQUEST");
    if (
      ["waitUntil"].includes(key) &&
      (value as unknown[]).some(
        (item) => !["terminal", "blocked"].includes(item as string),
      )
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "until" &&
      tool === "agent_wait" &&
      (value as unknown[]).some(
        (item) =>
          ![
            "succeeded",
            "failed",
            "cancelled",
            "timed_out",
            "blocked",
          ].includes(item as string),
      )
    )
      throw new Error("INVALID_REQUEST");
  }
  validateNested(input);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > 65_536)
    throw new Error("LIMIT_EXCEEDED");
}
function schemaForKey(key: string): unknown {
  if (
    [
      "wait",
      "dryRun",
      "managed",
      "connected",
      "force",
      "confirm",
      "createTask",
      "cascade",
    ].includes(key)
  )
    return { type: "boolean" };
  if (
    [
      "timeoutMs",
      "maxBytes",
      "limit",
      "assignmentGeneration",
      "durationMs",
      "pollMs",
    ].includes(key)
  )
    return { type: "integer", minimum: 1, maximum: 1_800_000 };
  if (["mode"].includes(key))
    return {
      type: "string",
      enum: ["single", "parallel", "chain", "dag", "implement_review_fix"],
    };
  if (["delivery"].includes(key))
    return { type: "string", enum: ["normal", "steer", "follow_up"] };
  if (["failureMode"].includes(key))
    return { type: "string", enum: ["fail_fast", "collect_all"] };
  if (["waitUntil"].includes(key))
    return {
      type: "array",
      maxItems: 8,
      items: { type: "string", enum: ["terminal", "blocked"] },
    };
  if (["until"].includes(key))
    return {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "string",
        enum: ["succeeded", "failed", "cancelled", "timed_out", "blocked"],
      },
    };
  if (
    ["ids", "taskIds", "include", "select", "agentIds", "followUps"].includes(
      key,
    )
  )
    return {
      type: "array",
      maxItems: 64,
      items: { type: "string", minLength: 1, maxLength: 256 },
    };
  if (["steps"].includes(key))
    return {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "profileId", "title", "objective"],
        properties: {
          key: { type: "string", maxLength: 256 },
          profileId: { type: "string", maxLength: 256 },
          title: { type: "string", maxLength: MAX_TEXT_BYTES },
          objective: { type: "string", maxLength: MAX_TEXT_BYTES },
          constraints: {
            type: "array",
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 8192 },
          },
          dependsOn: {
            type: "array",
            maxItems: 64,
            items: { type: "string", maxLength: 256 },
          },
        },
      },
    };
  if (["task"].includes(key))
    return {
      type: "object",
      additionalProperties: false,
      required: ["title", "objective"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES },
        objective: { type: "string", minLength: 1, maxLength: MAX_TEXT_BYTES },
        constraints: {
          type: "array",
          maxItems: 64,
          items: { type: "string", maxLength: MAX_TEXT_BYTES },
        },
      },
    };
  if (["project"].includes(key))
    return {
      type: "object",
      additionalProperties: false,
      required: ["cwd"],
      properties: { cwd: { type: "string", maxLength: 4096 } },
    };
  if (["isolation"].includes(key))
    return {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { type: "string", enum: ["shared-readonly", "worktree"] },
      },
    };
  if (["budget"].includes(key))
    return {
      type: "object",
      additionalProperties: false,
      required: ["wallTimeMs"],
      properties: {
        wallTimeMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
      },
    };
  if (["answer"].includes(key))
    return {
      type: "object",
      additionalProperties: false,
      required: ["optionId", "text"],
      properties: {
        optionId: { type: "string", minLength: 1, maxLength: 256 },
        text: { type: ["string", "null"], maxLength: MAX_TEXT_BYTES },
      },
    };
  return { type: "string", maxLength: MAX_TEXT_BYTES };
}
function parentInputSchema(tool: ParentToolName): unknown {
  return {
    type: "object",
    additionalProperties: false,
    maxProperties: 32,
    properties: {
      ...Object.fromEntries(
        parentInputKeys[tool].map((key) => [
          key,
          key === "timeoutMs" && tool === "agent_wait"
            ? { type: "integer", minimum: 1, maximum: 30_000 }
            : key === "timeoutMs" && tool === "agent_ask"
              ? { type: "integer", minimum: 1, maximum: 120_000 }
              : key === "mode" && tool === "group_wait"
                ? { type: "string", enum: ["all", "any"] }
                : key === "kind" && tool === "coordination_wait"
                  ? {
                      type: "string",
                      enum: [
                        "timer",
                        "signal",
                        "agent",
                        "task",
                        "result",
                        "question",
                        "group",
                      ],
                    }
                  : key === "until" && tool !== "agent_wait"
                    ? {
                        type: "array",
                        minItems: 1,
                        maxItems: 16,
                        items: { type: "string", minLength: 1, maxLength: 64 },
                      }
                    : key === "followUps"
                      ? {
                          type: "array",
                          maxItems: 3,
                          items: boundedString(MAX_TEXT_BYTES),
                        }
                      : schemaForKey(key),
        ]),
      ),
      idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
    },
    required: parentRequired[tool] ?? [],
  };
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: unknown,
    context: PiContextLike,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
    isError?: boolean;
  }>;
}
export interface PiToolBinding {
  adapter: PiAdapter | undefined;
  client: PiBrokerClient | undefined;
  parentAuthorized?: boolean;
  correlationState?: CorrelationState;
}
function register(api: PiApiLike, definition: ToolDefinition): void {
  api.registerTool?.(definition);
}
function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  const safe = boundedSecretFree(value);
  const encoded = JSON.stringify(safe);
  if (
    Buffer.byteLength(encoded, "utf8") <=
    DEFAULT_PARENT_TOOL_LIMITS.maxResponseBytes
  )
    return { content: [{ type: "text", text: encoded }], details: safe };
  const preview = boundedSecretFree(value, {
    ...DEFAULT_PARENT_TOOL_LIMITS,
    maxItems: 8,
    maxTextBytes: 1024,
  });
  const previewText = JSON.stringify(preview);
  const details =
    Buffer.byteLength(previewText, "utf8") <=
    DEFAULT_PARENT_TOOL_LIMITS.maxResponseBytes
      ? { truncated: true, preview }
      : { truncated: true };
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}
function validateResultInput(input: Record<string, unknown>): void {
  assertExactObject(
    input,
    [
      "schemaVersion",
      "status",
      "summary",
      "findings",
      "changedFiles",
      "commandsRun",
      "tests",
      "commits",
      "artifacts",
      "unresolved",
      "questions",
      "recommendedNextAction",
    ],
    [
      "schemaVersion",
      "status",
      "summary",
      "findings",
      "changedFiles",
      "commandsRun",
      "tests",
      "commits",
      "artifacts",
      "unresolved",
      "questions",
      "recommendedNextAction",
    ],
  );
  if (
    input.schemaVersion !== 1 ||
    !["succeeded", "failed", "cancelled"].includes(input.status as string) ||
    typeof input.summary !== "string" ||
    input.summary.length === 0 ||
    Buffer.byteLength(input.summary, "utf8") > 65_536 ||
    (input.recommendedNextAction !== null &&
      (typeof input.recommendedNextAction !== "string" ||
        Buffer.byteLength(input.recommendedNextAction, "utf8") > 8_192))
  )
    throw new Error("INVALID_REQUEST");
  const arrays: Record<string, number> = {
    findings: 256,
    changedFiles: 4_096,
    commandsRun: 256,
    tests: 256,
    commits: 64,
    artifacts: 128,
    unresolved: 128,
    questions: 64,
  };
  for (const [key, max] of Object.entries(arrays)) {
    if (!Array.isArray(input[key]) || input[key].length > max)
      throw new Error("INVALID_REQUEST");
    for (const item of input[key] as unknown[]) validateResultItem(key, item);
  }
  function validateResultItem(key: string, item: unknown): void {
    const specs: Record<string, { keys: string[]; required: string[] }> = {
      findings: {
        keys: ["severity", "title", "description", "evidence", "resolved"],
        required: ["severity", "title", "description", "evidence", "resolved"],
      },
      changedFiles: {
        keys: ["path", "change", "previousPath"],
        required: ["path", "change"],
      },
      commandsRun: {
        keys: ["command", "exitCode", "outcome"],
        required: ["command", "exitCode", "outcome"],
      },
      tests: {
        keys: [
          "name",
          "command",
          "status",
          "passed",
          "failed",
          "skipped",
          "evidence",
        ],
        required: [
          "name",
          "command",
          "status",
          "passed",
          "failed",
          "skipped",
          "evidence",
        ],
      },
      commits: { keys: ["sha", "subject"], required: ["sha", "subject"] },
      artifacts: {
        keys: ["kind", "path", "description", "mediaType"],
        required: ["kind", "path", "description", "mediaType"],
      },
      unresolved: {
        keys: ["title", "description", "blocking"],
        required: ["title", "description", "blocking"],
      },
      questions: {
        keys: ["questionId", "summary", "answered"],
        required: ["questionId", "summary", "answered"],
      },
    };
    const spec = specs[key];
    if (!spec) throw new Error("INVALID_REQUEST");
    assertExactObject(item, spec.keys, spec.required);
    const value = item as Record<string, unknown>;
    for (const field of [
      "title",
      "description",
      "summary",
      "subject",
      "path",
      "mediaType",
      "command",
      "name",
    ])
      if (value[field] !== undefined && value[field] !== null)
        assertInputString(
          value[field],
          field === "description"
            ? 8192
            : field === "path"
              ? 4096
              : field === "command"
                ? 8192
                : field === "subject"
                  ? 1024
                  : 1024,
        );
    if (
      key === "findings" &&
      (!["info", "low", "medium", "high", "critical"].includes(
        value.severity as string,
      ) ||
        typeof value.resolved !== "boolean" ||
        !Array.isArray(value.evidence) ||
        value.evidence.length > 32 ||
        value.evidence.some((item) => {
          try {
            assertInputString(item, 4096);
            return false;
          } catch {
            return true;
          }
        }) ||
        typeof value.title !== "string" ||
        Buffer.byteLength(value.title, "utf8") > 512 ||
        typeof value.description !== "string" ||
        Buffer.byteLength(value.description, "utf8") > 8192)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "changedFiles" &&
      (!["added", "modified", "deleted", "renamed", "unknown"].includes(
        value.change as string,
      ) ||
        typeof value.path !== "string" ||
        Buffer.byteLength(value.path, "utf8") > 4096 ||
        (value.previousPath !== undefined &&
          value.previousPath !== null &&
          (typeof value.previousPath !== "string" ||
            Buffer.byteLength(value.previousPath, "utf8") > 4096)))
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "commandsRun" &&
      (!["passed", "failed", "cancelled", "unknown"].includes(
        value.outcome as string,
      ) ||
        (value.exitCode !== null &&
          (!Number.isSafeInteger(value.exitCode) ||
            (value.exitCode as number) < 0 ||
            (value.exitCode as number) > 255)))
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "tests" &&
      (!["passed", "failed", "cancelled", "unknown"].includes(
        value.status as string,
      ) ||
        typeof value.name !== "string" ||
        Buffer.byteLength(value.name, "utf8") > 512 ||
        ["passed", "failed", "skipped"].some(
          (field) =>
            value[field] !== null &&
            (!Number.isSafeInteger(value[field]) ||
              (value[field] as number) < 0),
        ) ||
        (value.command !== null &&
          (typeof value.command !== "string" ||
            Buffer.byteLength(value.command, "utf8") > 8192)) ||
        (value.evidence !== null &&
          (typeof value.evidence !== "string" ||
            Buffer.byteLength(value.evidence, "utf8") > 4096)))
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "commits" &&
      (typeof value.sha !== "string" || !/^[0-9a-fA-F]{7,64}$/u.test(value.sha))
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "artifacts" &&
      (!["text", "json", "patch", "log", "report", "other"].includes(
        value.kind as string,
      ) ||
        typeof value.description !== "string" ||
        Buffer.byteLength(value.description, "utf8") > 1024 ||
        typeof value.mediaType !== "string" ||
        Buffer.byteLength(value.mediaType, "utf8") > 128)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "unresolved" &&
      (typeof value.blocking !== "boolean" ||
        typeof value.title !== "string" ||
        Buffer.byteLength(value.title, "utf8") > 512)
    )
      throw new Error("INVALID_REQUEST");
    if (
      key === "questions" &&
      (typeof value.answered !== "boolean" ||
        typeof value.questionId !== "string" ||
        !/^qst_[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.questionId))
    )
      throw new Error("INVALID_REQUEST");
  }
}
function validateQuestionInput(input: Record<string, unknown>): void {
  assertExactObject(
    input,
    [
      "schemaVersion",
      "prompt",
      "context",
      "options",
      "allowFreeform",
      "defaultOptionId",
      "timeoutMs",
    ],
    [
      "schemaVersion",
      "prompt",
      "context",
      "options",
      "allowFreeform",
      "defaultOptionId",
      "timeoutMs",
    ],
  );
  if (
    input.schemaVersion !== 1 ||
    typeof input.prompt !== "string" ||
    Buffer.byteLength(input.prompt, "utf8") > 16_384 ||
    input.prompt.length === 0 ||
    (input.context !== null && typeof input.context !== "string") ||
    (typeof input.context === "string" &&
      Buffer.byteLength(input.context, "utf8") > 16_384) ||
    typeof input.allowFreeform !== "boolean" ||
    !Array.isArray(input.options) ||
    input.options.length > 8 ||
    (input.options.length === 0 && input.allowFreeform === false) ||
    (input.defaultOptionId !== null &&
      (typeof input.defaultOptionId !== "string" ||
        !/^[A-Za-z0-9_-]{1,32}$/u.test(input.defaultOptionId))) ||
    !Number.isSafeInteger(input.timeoutMs) ||
    (input.timeoutMs as number) < 10_000 ||
    (input.timeoutMs as number) > 86_400_000
  )
    throw new Error("INVALID_REQUEST");
  for (const option of input.options) {
    assertExactObject(
      option,
      ["id", "label", "description"],
      ["id", "label", "description"],
    );
    if (
      typeof option.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/u.test(option.id) ||
      typeof option.label !== "string" ||
      option.label.length === 0 ||
      Buffer.byteLength(option.label, "utf8") > 1_024 ||
      (option.description !== null && typeof option.description !== "string") ||
      (typeof option.description === "string" &&
        Buffer.byteLength(option.description, "utf8") > 4_096)
    )
      throw new Error("INVALID_REQUEST");
  }
}
function validateQuestionAck(
  value: unknown,
  assignment: { runId: string; assignmentGeneration: number },
  toolCallId: string,
): {
  questionId: string;
  state: "open" | "answered" | "cancelled" | "timed_out";
  runId: string;
  assignmentGeneration: number;
  toolCallId: string;
  answer?: { optionId: string | null; text: string | null };
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_REQUEST");
  const ack = value as Record<string, unknown>;
  const state = ack.state;
  const keys =
    state === "answered"
      ? [
          "questionId",
          "runId",
          "assignmentGeneration",
          "toolCallId",
          "state",
          "answer",
        ]
      : ["questionId", "runId", "assignmentGeneration", "toolCallId", "state"];
  assertExactObject(ack, keys, keys);
  if (
    typeof ack.questionId !== "string" ||
    ack.questionId.length === 0 ||
    Buffer.byteLength(ack.questionId, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(ack.questionId) ||
    typeof ack.runId !== "string" ||
    ack.runId.length === 0 ||
    Buffer.byteLength(ack.runId, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(ack.runId) ||
    typeof ack.toolCallId !== "string" ||
    ack.toolCallId.length === 0 ||
    Buffer.byteLength(ack.toolCallId, "utf8") > 256 ||
    /[\u0000-\u001f\u007f]/u.test(ack.toolCallId) ||
    !Number.isSafeInteger(ack.assignmentGeneration) ||
    !["open", "answered", "cancelled", "timed_out"].includes(state as string) ||
    ack.runId !== assignment.runId ||
    ack.assignmentGeneration !== assignment.assignmentGeneration ||
    ack.toolCallId !== toolCallId
  )
    throw new Error("RUN_MISMATCH");
  if (state === "answered") {
    const answer = ack.answer;
    if (!answer || typeof answer !== "object" || Array.isArray(answer))
      throw new Error("INVALID_REQUEST");
    assertExactObject(answer, ["optionId", "text"], ["optionId", "text"]);
    const item = answer as Record<string, unknown>;
    if (
      (item.optionId !== null &&
        (typeof item.optionId !== "string" ||
          item.optionId.length === 0 ||
          Buffer.byteLength(item.optionId, "utf8") > 32 ||
          !/^[A-Za-z0-9_-]{1,32}$/u.test(item.optionId))) ||
      (item.text !== null &&
        (typeof item.text !== "string" ||
          item.text.length === 0 ||
          Buffer.byteLength(item.text, "utf8") > 16_384 ||
          /[\u0000-\u001f\u007f]/u.test(item.text))) ||
      (item.optionId === null && item.text === null)
    )
      throw new Error("INVALID_REQUEST");
    return {
      questionId: ack.questionId,
      state,
      runId: ack.runId,
      assignmentGeneration: ack.assignmentGeneration,
      toolCallId: ack.toolCallId,
      answer: {
        optionId: item.optionId as string | null,
        text: item.text as string | null,
      },
    };
  }
  return {
    questionId: ack.questionId,
    state: state as "open" | "cancelled" | "timed_out",
    runId: ack.runId,
    assignmentGeneration: ack.assignmentGeneration,
    toolCallId: ack.toolCallId,
  };
}
function assertBoundedBody(value: Record<string, unknown>): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES)
    throw new Error("LIMIT_EXCEEDED");
}
export function registerManagedChildTools(
  api: PiApiLike,
  adapterOrBinding: PiAdapter | PiToolBinding,
  client?: PiBrokerClient,
): void {
  const binding: PiToolBinding = client
    ? { adapter: adapterOrBinding as PiAdapter, client }
    : (adapterOrBinding as PiToolBinding);
  register(api, {
    name: "orchestrator_result",
    label: "Publish orchestrator result",
    description:
      "Publish the single structured terminal result for the current managed task. Correlation identity is supplied by the adapter.",
    parameters: resultSchema,
    async execute(_id, params, signal) {
      if (signal.aborted) throw new Error("CANCELLED");
      const adapter = binding.adapter;
      const client = binding.client;
      if (!adapter || !client || !client.connected)
        throw new Error("AGENT_DISCONNECTED");
      const assignment = adapter.assignmentForTools();
      if (!assignment) throw new Error("RUN_MISMATCH");
      validateResultInput(params);
      assertBoundedBody(params);
      const result = await client.request("result.publish", {
        agentId: assignment.agentId,
        taskId: assignment.taskId,
        runId: assignment.runId,
        assignmentGeneration: assignment.assignmentGeneration,
        result: params,
      });
      return textResult(result);
    },
  });
  register(api, {
    name: "orchestrator_ask",
    label: "Ask orchestrator question",
    description:
      "Ask one blocking structured question for the current managed task. Correlation identity is supplied by the adapter.",
    parameters: questionSchema,
    async execute(_id, params, signal) {
      if (signal.aborted) throw new Error("CANCELLED");
      const adapter = binding.adapter;
      const client = binding.client;
      if (!adapter || !client || !client.connected)
        throw new Error("AGENT_DISCONNECTED");
      const assignment = adapter.assignmentForTools();
      if (!assignment) throw new Error("RUN_MISMATCH");
      validateQuestionInput(params);
      assertBoundedBody(params);
      api.events?.emit("herdr:blocked", {
        active: true,
        label: "Waiting for an orchestrator answer",
      });
      try {
        const waiter = client.registerQuestionWaiter(
          _id,
          assignment.runId,
          params.timeoutMs as number,
          signal,
        );
        void waiter.catch(() => undefined);
        let openPromise: Promise<unknown>;
        try {
          openPromise = client.request("question.open", {
            agentId: assignment.agentId,
            taskId: assignment.taskId,
            runId: assignment.runId,
            assignmentGeneration: assignment.assignmentGeneration,
            toolCallId: _id,
            question: params,
          });
        } catch (error) {
          client.discardQuestionWaiter(_id);
          throw error;
        }
        void openPromise.catch(() => undefined);
        let ack: unknown;
        try {
          const first = await Promise.race([
            openPromise.then((value) => ({ kind: "ack" as const, value })),
            waiter.then((value) => ({ kind: "waiter" as const, value })),
          ]);
          if (first.kind === "waiter") {
            const earlyQuestionId =
              typeof client.questionIdForToolCall === "function"
                ? client.questionIdForToolCall(_id)
                : undefined;
            void openPromise.then(
              (lateAck) => {
                try {
                  const parsedLateAck = validateQuestionAck(
                    lateAck,
                    assignment,
                    _id,
                  );
                  if (
                    earlyQuestionId !== undefined &&
                    parsedLateAck.questionId !== earlyQuestionId
                  )
                    throw new Error("QUESTION_DELIVERY_INVALID");
                } catch {
                  client.close();
                } finally {
                  client.discardQuestionWaiter(_id);
                }
              },
              () => {
                client.discardQuestionWaiter(_id);
              },
            );
            return textResult(first.value);
          }
          ack = first.value;
        } catch (error) {
          client.discardQuestionWaiter(_id);
          throw error;
        }
        let parsedAck: ReturnType<typeof validateQuestionAck>;
        try {
          parsedAck = validateQuestionAck(ack, assignment, _id);
        } catch (error) {
          client.discardQuestionWaiter(_id);
          throw error;
        }
        if (parsedAck.state !== "open") {
          client.discardQuestionWaiter(_id);
          return textResult({
            state: parsedAck.state,
            ...(parsedAck.state === "answered"
              ? { answer: parsedAck.answer }
              : {}),
          });
        }
        try {
          client.bindQuestionWaiter(_id, parsedAck.questionId);
        } catch (error) {
          client.discardQuestionWaiter(_id);
          throw error;
        }
        try {
          const answer = await waiter;
          return textResult(answer);
        } finally {
          client.discardQuestionWaiter(_id);
        }
      } finally {
        api.events?.emit("herdr:blocked", { active: false });
      }
    },
  });
}

function waitForParentPoll(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("CANCELLED"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function executeParentWaitRequest(
  service: ParentToolService,
  request: ParentToolRequest,
  principal: ToolPrincipal,
  signal: AbortSignal,
  deadline: number,
): Promise<ParentToolResponse | undefined> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("CANCELLED"));
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("CANCELLED"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(undefined);
    }, remainingMs);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    void service.execute(request, principal, signal).then(
      (response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export function registerParentTools(
  api: PiApiLike,
  adapterOrBinding: PiAdapter | PiToolBinding,
  client?: PiBrokerClient,
): void {
  const binding: PiToolBinding = client
    ? { adapter: adapterOrBinding as PiAdapter, client }
    : (adapterOrBinding as PiToolBinding);
  const principalFromClient = (): ToolPrincipal => {
    const adapter = binding.adapter;
    const client = binding.client;
    if (!adapter || !client || !client.connected)
      throw new Error("AGENT_DISCONNECTED");
    const p = client.principal;
    if (!p || !p.id || !Array.isArray(p.permissions))
      throw new Error("BROKER_PRINCIPAL_UNAVAILABLE");
    return {
      id: p.id,
      kind: p.kind,
      permissions: p.permissions,
      ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
    };
  };
  const broker = {
    invoke: async (
      method: string,
      params: Record<string, unknown>,
      _principal: ToolPrincipal,
      idempotencyKey?: string,
    ) => {
      const client = binding.client;
      if (!client?.connected) throw new Error("AGENT_DISCONNECTED");
      return client.request(
        method,
        params,
        idempotencyKey ? { idempotencyKey } : {},
      );
    },
  };
  const service = new ParentToolService(broker);
  const permissions = new Set(principalFromClient().permissions);
  for (const tool of PARENT_TOOL_NAMES) {
    if (
      tool === "delegate" &&
      !permissions.has("delegate") &&
      !permissions.has("manage:all")
    )
      continue;
    register(api, {
      name: tool,
      label: `Orchestrator ${tool}`,
      description: `Use broker method for ${tool}. The broker checks current state and parent scope on every call.`,
      parameters: parentInputSchema(tool as ParentToolName),
      async execute(_id, params, signal) {
        const { idempotencyKey, ...provided } = params;
        const raw =
          tool === "coordination_wait" && provided.kind === "timer"
            ? {
                ...provided,
                startedAt:
                  typeof provided.startedAt === "string"
                    ? provided.startedAt
                    : new Date().toISOString(),
              }
            : provided;
        if (idempotencyKey !== undefined)
          assertInputString(idempotencyKey, 256);
        const principal = principalFromClient();
        if (tool === "delegate" && binding.parentAuthorized === false)
          throw new Error("PERMISSION_DENIED");
        const adapter = binding.adapter;
        const client = binding.client;
        if (!adapter || !client) throw new Error("AGENT_DISCONNECTED");
        validateParentInput(tool as ParentToolName, raw);
        const request: ParentToolRequest = {
          tool: tool as ParentToolName,
          input: raw,
          ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
        };
        if (!isParentToolRequest(request)) throw new Error("INVALID_REQUEST");
        let response: ParentToolResponse;
        if (
          tool === "agent_wait" ||
          tool === "coordination_wait" ||
          tool === "group_wait"
        ) {
          const until = new Set(
            Array.isArray(raw.until) ? (raw.until as string[]) : [],
          );
          const deadline = Date.now() + (raw.timeoutMs as number);
          const initial = await executeParentWaitRequest(
            service,
            request,
            principal,
            signal,
            deadline,
          );
          if (!initial) throw new Error("WAIT_TIMEOUT");
          response = initial;
          const pollRequest: ParentToolRequest = {
            tool: request.tool,
            input: request.input,
          };
          while (
            response.ok &&
            (tool === "agent_wait"
              ? !until.has(
                  String(
                    (response.result as Record<string, unknown> | undefined)
                      ?.state,
                  ),
                )
              : (response.result as Record<string, unknown> | undefined)
                  ?.ready !== true) &&
            Date.now() < deadline
          ) {
            await waitForParentPoll(
              Math.min(100, Math.max(1, deadline - Date.now())),
              signal,
            );
            const next = await executeParentWaitRequest(
              service,
              pollRequest,
              principal,
              signal,
              deadline,
            );
            if (!next) break;
            response = next;
          }
        } else response = await service.execute(request, principal, signal);
        if (!response.ok) {
          const error = boundedSecretFree(
            response.error ?? {
              code: "REQUEST_FAILED",
              message: "The broker rejected the parent tool request.",
            },
          );
          const content = JSON.stringify(error);
          return {
            content: [{ type: "text", text: content }],
            details: error,
            isError: true,
          };
        }
        return textResult(response.result);
      },
    });
  }
}

export function registerOrchestratorTools(
  api: PiApiLike,
  binding: PiToolBinding,
  managed: boolean,
  permissions: readonly string[] = [],
): void {
  if (managed) registerManagedChildTools(api, binding);
  if (
    !managed ||
    permissions.includes("delegate") ||
    permissions.includes("manage:all")
  )
    registerParentTools(api, binding);
  binding.parentAuthorized =
    permissions.includes("delegate") || permissions.includes("manage:all");
}
