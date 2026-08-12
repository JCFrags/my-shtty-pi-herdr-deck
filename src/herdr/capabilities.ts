import { createHash } from "node:crypto";
import { canonicalJson } from "../shared/canonical-json.js";
export interface HerdrCapabilities {
  schemaHash: string;
  binaryIdentity?: string;
  mandatory: Record<string, boolean>;
  optional: Record<string, boolean>;
  supports(method: string): boolean;
  require(methods: readonly string[]): void;
}
const MANDATORY = [
  "session.snapshot",
  "events.subscribe",
  "workspace.list",
  "workspace.get",
  "workspace.focus",
  "workspace.close",
  "tab.create",
  "tab.get",
  "tab.close",
  "pane.list",
  "pane.get",
  "pane.focus",
  "pane.close",
  "agent.list",
  "agent.get",
  "agent.start",
  "agent.focus",
  "worktree.list",
  "worktree.create",
  "worktree.open",
  "worktree.remove",
];
const OPTIONAL = [
  "workspace.create",
  "pane.report_metadata",
  "agent.prompt",
  "agent.wait",
  "agent.read",
  "agent.interrupt",
];
function methods(schema: unknown): Set<string> {
  const set = new Set<string>(),
    seen = new Set<unknown>();
  const visit = (x: unknown, depth: number) => {
    if (depth > 30 || x === null || typeof x !== "object" || seen.has(x))
      return;
    seen.add(x);
    if (Array.isArray(x)) return x.forEach((v) => visit(v, depth + 1));
    const r = x as Record<string, unknown>;
    if (Array.isArray(r.methods))
      for (const m of r.methods) if (typeof m === "string") set.add(m);
    const schemas = r.schemas;
    if (schemas && typeof schemas === "object" && !Array.isArray(schemas))
      for (const schema of Object.values(schemas)) visit(schema, depth + 1);
    const p = r.properties;
    if (p && typeof p === "object") {
      const m = (p as Record<string, unknown>).method;
      if (m && typeof m === "object") {
        const mr = m as Record<string, unknown>;
        if (typeof mr.const === "string") set.add(mr.const);
        if (Array.isArray(mr.enum))
          for (const v of mr.enum) if (typeof v === "string") set.add(v);
      }
    }
    for (const k of [
      "oneOf",
      "anyOf",
      "allOf",
      "items",
      "$defs",
      "definitions",
      "properties",
    ])
      visit(r[k], depth + 1);
  };
  visit(schema, 0);
  return set;
}
export function projectCapabilities(
  schema: unknown,
  binaryIdentity?: string,
): HerdrCapabilities {
  const set = methods(schema);
  const mandatory = Object.fromEntries(MANDATORY.map((m) => [m, set.has(m)]));
  const optional = Object.fromEntries(OPTIONAL.map((m) => [m, set.has(m)]));
  const schemaHash = createHash("sha256")
    .update(canonicalJson(schema))
    .digest("hex");
  return {
    schemaHash,
    ...(binaryIdentity ? { binaryIdentity } : {}),
    mandatory,
    optional,
    supports: (m) => set.has(m),
    require: (ms) => {
      const missing = ms.filter((m) => !set.has(m));
      if (missing.length)
        throw new Error(`HERDR_CAPABILITY_MISSING: ${missing.join(", ")}`);
    },
  };
}
export interface CapabilityIdentity {
  binaryIdentity: string;
  schemaHash: string;
  adapterIdentity: string;
}
export class CapabilityCache {
  #cache = new Map<string, HerdrCapabilities>();
  static key(identity: CapabilityIdentity): string {
    return canonicalJson(identity);
  }
  get(identity: CapabilityIdentity | string) {
    return this.#cache.get(
      typeof identity === "string" ? identity : CapabilityCache.key(identity),
    );
  }
  set(identity: CapabilityIdentity | string, value: HerdrCapabilities) {
    this.#cache.set(
      typeof identity === "string" ? identity : CapabilityCache.key(identity),
      value,
    );
    return value;
  }
  clear() {
    this.#cache.clear();
  }
}
