import { access, constants, lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { resolvePaths } from "../shared/paths.js";
import { HerdrApi } from "../herdr/api.js";
export interface CapabilityReport {
  name: string;
  available: boolean;
  mandatory: boolean;
  detail: string;
}
export interface DoctorReport {
  version: string;
  platform: string;
  node: string;
  checks: CapabilityReport[];
  ok: boolean;
}
function check(
  name: string,
  available: boolean,
  mandatory: boolean,
  detail: string,
): CapabilityReport {
  return { name, available, mandatory, detail };
}
export async function doctor(
  options: {
    herdrBinary?: string;
    herdrSocket?: string;
    schema?: unknown;
  } = {},
): Promise<DoctorReport> {
  const paths = resolvePaths();
  const checks: CapabilityReport[] = [];
  checks.push(
    check("linux", process.platform === "linux", true, process.platform),
  );
  checks.push(
    check(
      "node",
      Number(process.versions.node.split(".")[0]) >= 22,
      true,
      process.versions.node,
    ),
  );
  const git = await commandAvailable("git");
  checks.push(check("git", git, true, git ? "executable" : "not found"));
  const herdrBinary = options.herdrBinary ?? process.env.HERDR_BIN_PATH;
  const herdr = !!herdrBinary && (await commandAvailablePath(herdrBinary));
  checks.push(
    check("herdr-binary", herdr, true, herdrBinary ?? "not configured"),
  );
  if (options.schema) {
    const api = new HerdrApi({
      runner: async () => ({
        stdout: JSON.stringify(options.schema),
        stderr: "",
        exitCode: 0,
      }),
    });
    await api.readSchema().catch(() => undefined);
    for (const method of [
      "session.snapshot",
      "events.subscribe",
      "tab.create",
      "tab.close",
      "agent.start",
      "worktree.create",
      "worktree.remove",
    ])
      checks.push(
        check(
          `herdr-capability:${method}`,
          api.supports(method),
          true,
          api.supports(method) ? "supported" : "missing",
        ),
      );
    for (const method of ["agent.interrupt", "agent.wait", "agent.read"])
      checks.push(
        check(
          `herdr-optional:${method}`,
          api.supports(method),
          false,
          api.supports(method) ? "supported" : "degraded",
        ),
      );
  }
  if (options.herdrSocket) {
    const socketPath = options.herdrSocket;
    const exists = await pathExists(socketPath);
    const live = exists && (await socketLive(socketPath));
    checks.push(
      check("herdr-socket", live, true, live ? "connected" : socketPath),
    );
  }
  checks.push(
    check("state-path", await safeDirectory(paths.root), true, paths.root),
  );
  checks.push(
    check(
      "runtime-path",
      await safeDirectory(paths.runtime),
      true,
      paths.runtime,
    ),
  );
  const adapter = process.env.PI_HERDR_ORCH_ADAPTER_ID;
  checks.push(
    check(
      "pi-integration",
      !!adapter,
      !!herdrBinary,
      adapter ?? "official adapter identity is not configured",
    ),
  );
  checks.push(
    check(
      "broker-lock-config",
      !!process.env.PI_HERDR_ORCH_BROKER_LOCK,
      false,
      process.env.PI_HERDR_ORCH_BROKER_LOCK ? "configured" : "default",
    ),
  );
  return {
    version: "0.1.0",
    platform: process.platform,
    node: process.versions.node,
    checks,
    ok: checks.every((item) => !item.mandatory || item.available),
  };
}
export function doctorJson(report: DoctorReport): string {
  return JSON.stringify(report);
}
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function socketLive(path: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}
async function safeDirectory(path: string): Promise<boolean> {
  try {
    const s = await lstat(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
async function commandAvailable(name: string): Promise<boolean> {
  return commandAvailablePath(`/usr/bin/${name}`);
}
async function commandAvailablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
