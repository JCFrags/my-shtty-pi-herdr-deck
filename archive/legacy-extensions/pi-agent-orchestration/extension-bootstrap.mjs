import { isAbsolute, resolve } from "node:path";
import { canonicalStringify, cloneCanonical } from "./canonical.mjs";
import { pathContained } from "./secure-store.mjs";
import { registerOrchestrationTools } from "./tool-composition.mjs";

function exactEnvironment(input) {
  const required = [
    "HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID",
    "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "PI_SESSION_FILE",
  ];
  const output = {};
  for (const name of required) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    const value = descriptor?.value;
    if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error(`Required environment ${name} is unavailable.`);
    output[name] = value;
  }
  if (output.HERDR_ENV !== "1") throw new Error("Herdr environment is disabled.");
  for (const name of ["HERDR_SOCKET_PATH", "PI_SESSION_FILE"]) {
    if (!isAbsolute(output[name]) || resolve(output[name]) !== output[name]) throw new Error(`${name} is not canonical and absolute.`);
  }
  return output;
}

function selectCurrentEntry(policy, environment, cwd) {
  if (!isAbsolute(cwd) || resolve(cwd) !== cwd) throw new Error("Current project root is not canonical and absolute.");
  const matches = policy.manifest.entries.filter((entry) => (
    entry.projectRoot === cwd &&
    entry.start.workspaceId === environment.HERDR_WORKSPACE_ID &&
    entry.start.tabId === environment.HERDR_TAB_ID &&
    entry.start.paneId === environment.HERDR_PANE_ID &&
    entry.provider === environment.PI_PROVIDER &&
    entry.model === `${environment.PI_PROVIDER}/${environment.PI_MODEL}` &&
    entry.thinking === environment.PI_REASONING_LEVEL &&
    pathContained(entry.session.root, environment.PI_SESSION_FILE)
  ));
  if (matches.length !== 1) throw new Error("Current Pi process does not match one exact manifest entry.");
  return cloneCanonical(matches[0]);
}

function validateSessionContext(ctx, entry, environment) {
  if (ctx === null || typeof ctx !== "object") throw new Error("Pi session context is unavailable.");
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  const model = ctx.model;
  const observed = {
    cwd: ctx.cwd,
    trusted: ctx.isProjectTrusted?.() === true,
    provider: model?.provider ?? null,
    model: model ? `${model.provider}/${model.id}` : null,
    thinking: ctx.thinkingLevel ?? null,
    sessionFile: sessionFile ?? null,
  };
  const expected = {
    cwd: entry.projectRoot,
    trusted: entry.trustState === "trusted",
    provider: entry.provider,
    model: entry.model,
    thinking: entry.thinking,
    sessionFile: environment.PI_SESSION_FILE,
  };
  if (canonicalStringify(observed) !== canonicalStringify(expected) || !pathContained(entry.session.root, sessionFile)) {
    throw new Error("Current Pi session policy does not match the manifest entry.");
  }
  return Object.freeze(observed);
}

export async function configureOrchestrationExtension(pi, {
  configPath,
  loadPolicy,
  verifyProtectedFile,
  prepareSession,
  environment = process.env,
  cwd = process.cwd(),
} = {}) {
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function" || typeof pi.registerTool !== "function") {
    throw new Error("Pi extension API is invalid.");
  }
  if (typeof configPath !== "string" || !isAbsolute(configPath) || resolve(configPath) !== configPath) {
    throw new Error("The orchestration config path is not fixed and canonical.");
  }
  for (const [name, callback] of Object.entries({ loadPolicy, verifyProtectedFile, prepareSession })) {
    if (typeof callback !== "function") throw new Error(`Extension bootstrap requires ${name}.`);
  }

  let policy;
  try {
    policy = await loadPolicy(configPath, { verifyProtectedFile });
  } catch {
    return Object.freeze({ enabled: false, reason: "invalid_configuration" });
  }
  if (policy?.enabled !== true) return Object.freeze({ enabled: false, reason: policy?.reason ?? "disabled" });

  let env;
  let currentEntry;
  let prepared;
  try {
    env = exactEnvironment(environment);
    if (env.HERDR_SOCKET_PATH !== policy.config.herdrSocketPath) throw new Error("Herdr socket does not match the fixed configuration.");
    currentEntry = selectCurrentEntry(policy, env, cwd);
    prepared = await prepareSession({ policy, currentEntry, environment: env });
    if (
      prepared === null || typeof prepared !== "object" ||
      typeof prepared.sessionStartHandler !== "function" || typeof prepared.activate !== "function" || typeof prepared.close !== "function"
    ) {
      throw new Error("Prepared session runtime is invalid.");
    }
  } catch {
    return Object.freeze({ enabled: false, reason: "invalid_runtime_context" });
  }

  let active = null;
  let toolsRegistered = false;
  pi.on("session_start", prepared.sessionStartHandler);
  pi.on("session_start", async (_event, ctx) => {
    if (active !== null) throw new Error("Orchestration session is already active.");
    const observedPolicy = validateSessionContext(ctx, currentEntry, env);
    let activated;
    try {
      activated = await prepared.activate({ ctx, observedPolicy });
      if (activated === null || typeof activated !== "object" || activated.runtime === undefined) {
        throw new Error("Orchestration activation did not return a runtime.");
      }
    } catch (error) {
      await prepared.close();
      throw error;
    }
    active = activated;
    try {
      if (toolsRegistered) throw new Error("Orchestration tools are already registered.");
      registerOrchestrationTools(pi, activated.runtime, currentEntry.capabilities);
      toolsRegistered = true;
    } catch (error) {
      active = null;
      await activated.runtime?.close?.();
      await prepared.close();
      throw error;
    }
  });
  pi.on("session_shutdown", async () => {
    const closing = active;
    active = null;
    if (closing?.runtime?.close) await closing.runtime.close();
    await prepared.close();
  });

  return Object.freeze({
    enabled: true,
    reason: null,
    entryId: currentEntry.entryId,
    logicalAgent: currentEntry.logicalAgent,
  });
}
