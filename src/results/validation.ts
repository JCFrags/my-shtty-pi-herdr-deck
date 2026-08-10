import { createHash } from "node:crypto";
import type { QuestionBody, ResultBody } from "./types.js";
import { OrchestratorError } from "../shared/errors.js";
const id = /^[A-Za-z0-9_-]{1,32}$/;
const qid = /^qst_[0-9A-HJKMNP-TV-Z]{26}$/;
const secret = /(api[_-]?key|authorization|bearer|token|private[_-]?key|cookie|session[_-]?file|process\.env)/i;
function text(v: unknown, max: number): v is string { return typeof v === "string" && v.length > 0 && v.length <= max && ![...v].some((c) => c.charCodeAt(0) < 0x20 && c !== "\n" && c !== "\t"); }
function array(v: unknown, max: number): v is unknown[] { return Array.isArray(v) && v.length <= max; }
export function validateResult(value: unknown): asserts value is ResultBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrchestratorError("INVALID_REQUEST", "Result must be an object.");
  const r = value as Record<string, unknown>;
  const required = ["schemaVersion","status","summary","findings","changedFiles","commandsRun","tests","commits","artifacts","unresolved","questions","recommendedNextAction"];
  if (Object.keys(r).some((k) => !required.includes(k)) || required.some((k) => !(k in r)) || r.schemaVersion !== 1 || !["succeeded","failed","cancelled"].includes(String(r.status)) || !text(r.summary, 65536)) throw new OrchestratorError("INVALID_REQUEST", "Result does not match schema v1.");
  if (!array(r.findings, 256) || !array(r.changedFiles, 4096) || !array(r.commandsRun, 256) || !array(r.tests, 256) || !array(r.commits, 64) || !array(r.artifacts, 128) || !array(r.unresolved, 128) || !array(r.questions, 64)) throw new OrchestratorError("LIMIT_EXCEEDED", "Result collection exceeds its bound.");
  if (r.recommendedNextAction !== null && !text(r.recommendedNextAction, 8192)) throw new OrchestratorError("INVALID_REQUEST", "Result next action is invalid.");
  const encoded = JSON.stringify(value);
  if (secret.test(encoded)) throw new OrchestratorError("INVALID_REQUEST", "Result contains a forbidden secret or private runtime field.");
  for (const item of r.questions as unknown[]) { const q = item as Record<string, unknown>; if (!qid.test(String(q.questionId))) throw new OrchestratorError("INVALID_REQUEST", "Result question ID is invalid."); }
}
export function validateQuestion(value: unknown): asserts value is QuestionBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OrchestratorError("INVALID_REQUEST", "Question must be an object.");
  const q = value as Record<string, unknown>;
  const keys = ["schemaVersion","prompt","options","allowFreeform","context","defaultOptionId","timeoutMs"];
  if (Object.keys(q).some((k) => !keys.includes(k)) || keys.some((k) => !(k in q)) || q.schemaVersion !== 1 || !text(q.prompt, 16384) || !array(q.options, 8) || typeof q.allowFreeform !== "boolean" || (q.context !== null && !text(q.context, 16384)) || (q.defaultOptionId !== null && !id.test(String(q.defaultOptionId))) || !Number.isSafeInteger(q.timeoutMs) || Number(q.timeoutMs) < 10000 || Number(q.timeoutMs) > 86400000 || (!q.allowFreeform && (q.options as unknown[]).length === 0)) throw new OrchestratorError("INVALID_REQUEST", "Question does not match schema v1.");
  const seen = new Set<string>();
  for (const item of q.options as unknown[]) { const o = item as Record<string, unknown>; if (Object.keys(o).some((k) => !["id","label","description"].includes(k)) || !id.test(String(o.id)) || seen.has(String(o.id)) || !text(o.label, 1024) || (o.description !== null && !text(o.description, 4096))) throw new OrchestratorError("INVALID_REQUEST", "Question option is invalid."); seen.add(String(o.id)); }
  if (q.defaultOptionId !== null && !seen.has(String(q.defaultOptionId))) throw new OrchestratorError("INVALID_REQUEST", "Default option is not present.");
  if (secret.test(JSON.stringify(value))) throw new OrchestratorError("INVALID_REQUEST", "Question contains a forbidden secret or private runtime field.");
}
export function payloadHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
