import type { HerdrCapabilities } from "./capabilities.js";
import { HerdrProcessRunner } from "./runner.js";
import { normalizeSnapshot } from "./normalizers.js";
import type { HerdrSnapshot } from "./types.js";
export class HerdrCli {
  constructor(
    readonly runner: HerdrProcessRunner,
    readonly capabilities: HerdrCapabilities,
  ) {}
  async snapshot(): Promise<HerdrSnapshot> {
    this.capabilities.require(["session.snapshot"]);
    return normalizeSnapshot(
      await this.runner.json(["session", "snapshot", "--json"]),
    );
  }
  async createTab(input: {
    workspaceId: string;
    cwd: string;
    label: string;
    env: Record<string, string>;
  }) {
    this.capabilities.require(["tab.create"]);
    return await this.runner.json([
      "tab",
      "create",
      "--workspace",
      input.workspaceId,
      "--cwd",
      input.cwd,
      "--label",
      input.label,
      ...Object.entries(input.env).flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--no-focus",
      "--json",
    ]);
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
  async startPi(input: {
    name: string;
    paneId: string;
    args: readonly string[];
    timeoutMs?: number;
  }) {
    this.capabilities.require(["agent.start"]);
    return await this.runner.json([
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
    ]);
  }
  async createWorktree(input: {
    workspaceId: string;
    branch: string;
    base: string;
    label: string;
  }) {
    this.capabilities.require(["worktree.create"]);
    return await this.runner.json([
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
      "--json",
    ]);
  }
  async removeWorktree(id: string) {
    this.capabilities.require(["worktree.remove"]);
    await this.runner.run(["worktree", "remove", id]);
  }
}
