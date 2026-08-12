import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { configureOrchestrationExtension } from "./extension-bootstrap.mjs";
import { prepareLiveSession } from "./live-session-runtime.mjs";
import { verifyProtectedFile } from "./participant-registry.mjs";
import { loadSecurePolicy } from "./secure-store.mjs";

const CONFIG_PATH = join(homedir(), ".agents", "runtime", "pi-agent-orchestration", "config.json");

export default async function piAgentOrchestration(pi: ExtensionAPI): Promise<void> {
  await configureOrchestrationExtension(pi, {
    configPath: CONFIG_PATH,
    loadPolicy: loadSecurePolicy,
    verifyProtectedFile,
    prepareSession: prepareLiveSession,
  });
}
