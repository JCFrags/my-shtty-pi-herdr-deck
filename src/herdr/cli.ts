import type { HerdrCapabilities } from "./capabilities.js";
import { normalizeSnapshot } from "./normalizers.js";
import { HerdrProcessError, HerdrProcessRunner } from "./runner.js";
import type { HerdrSnapshot } from "./types.js";

function commandResult(
  value: unknown,
  expectedId: string,
  expectedType: string,
): Record<string, unknown> {
  const response =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const result =
    response?.result &&
    typeof response.result === "object" &&
    !Array.isArray(response.result)
      ? (response.result as Record<string, unknown>)
      : undefined;
  if (
    !response ||
    response.id !== expectedId ||
    Object.keys(response).length !== 2 ||
    !("result" in response) ||
    !result ||
    result.type !== expectedType
  )
    throw new HerdrProcessError(
      "HERDR_INVALID_OUTPUT",
      `Herdr ${expectedId} did not return the expected success envelope.`,
    );
  return result;
}

export class HerdrCli {
  constructor(
    readonly runner: HerdrProcessRunner,
    readonly capabilities: HerdrCapabilities,
  ) {}
  async snapshot(): Promise<HerdrSnapshot> {
    this.capabilities.require(["session.snapshot"]);
    return normalizeSnapshot(
      commandResult(
        await this.runner.json(["api", "snapshot"]),
        "cli:api:snapshot",
        "session_snapshot",
      ),
    );
  }
  requireMutationCapabilities(methods: readonly string[]): void {
    this.capabilities.require(methods);
  }
  async createWorkspace(input: {
    cwd: string;
    label: string;
    env: Record<string, string>;
  }) {
    this.capabilities.require(["workspace.create"]);
    return commandResult(
      await this.runner.json([
        "workspace",
        "create",
        "--cwd",
        input.cwd,
        "--label",
        input.label,
        ...Object.entries(input.env).flatMap(([k, v]) => [
          "--env",
          `${k}=${v}`,
        ]),
        "--no-focus",
      ]),
      "cli:workspace:create",
      "workspace_created",
    );
  }
  async closeWorkspace(id: string) {
    this.capabilities.require(["workspace.close"]);
    await this.runner.run(["workspace", "close", id]);
  }
  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env: Record<string, string>;
  }) {
    this.capabilities.require(["tab.create"]);
    return commandResult(
      await this.runner.json([
        "tab",
        "create",
        "--workspace",
        input.workspaceId,
        "--cwd",
        input.cwd,
        "--label",
        input.label,
        ...Object.entries(input.env).flatMap(([k, v]) => [
          "--env",
          `${k}=${v}`,
        ]),
        "--no-focus",
      ]),
      "cli:tab:create",
      "tab_created",
    );
  }
  async closeTab(id: string) {
    this.capabilities.require(["tab.close"]);
    await this.runner.run(["tab", "close", id]);
  }
  async focusAgent(id: string) {
    this.capabilities.require(["agent.focus"]);
    await this.runner.run(["agent", "focus", id]);
  }
  async interruptAgent(id: string) {
    this.capabilities.require(["agent.interrupt"]);
    await this.runner.run(["agent", "interrupt", id]);
  }
  async closePane(id: string) {
    this.capabilities.require(["pane.close"]);
    await this.runner.run(["pane", "close", id]);
  }
  async stopAgent(id: string) {
    this.capabilities.require(["agent.stop"]);
    await this.runner.run(["agent", "stop", id]);
  }
  async startPi(input: {
    name: string;
    paneId: string;
    args: readonly string[];
    timeoutMs?: number;
  }) {
    this.capabilities.require(["agent.start"]);
    return commandResult(
      await this.runner.json([
        "agent",
        "start",
        input.name,
        "--kind",
        "pi",
        "--pane",
        input.paneId,
        "--timeout",
        String(input.timeoutMs ?? 30_000),
        "--",
        ...input.args,
      ]),
      "cli:agent:start",
      "agent_started",
    );
  }
  async createWorktree(input: {
    workspaceId: string;
    branch: string;
    base: string;
    label: string;
  }) {
    this.capabilities.require(["worktree.create"]);
    return commandResult(
      await this.runner.json([
        "worktree",
        "create",
        "--workspace",
        input.workspaceId,
        "--branch",
        input.branch,
        "--base",
        input.base,
        "--label",
        input.label,
        "--no-focus",
      ]),
      "cli:worktree:create",
      "worktree_created",
    );
  }
  async removeWorktree(workspaceId: string) {
    this.capabilities.require(["worktree.remove"]);
    await this.runner.run(["worktree", "remove", "--workspace", workspaceId]);
  }
}
