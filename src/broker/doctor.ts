import { access, constants, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  canonicalHerdrSocket,
  ensurePrivateDirectory,
  resolvePaths,
} from "../shared/paths.js";
import { HerdrApi } from "../herdr/api.js";
import { HerdrProvisioner } from "../herdr/provisioner.js";

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

async function safeExecutable(path: string | undefined): Promise<boolean> {
  if (!path || !isAbsolute(path)) return false;
  try {
    const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]);
    return (
      canonical === path &&
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      (stat.mode & 0o111) !== 0 &&
      (await access(path, constants.X_OK).then(
        () => true,
        () => false,
      ))
    );
  } catch {
    return false;
  }
}

export async function doctor(
  options: {
    herdrBinary?: string;
    herdrSocket?: string;
    schema?: unknown;
  } = {},
): Promise<DoctorReport> {
  const checks: CapabilityReport[] = [];
  checks.push(
    check("linux", process.platform === "linux", true, process.platform),
  );
  const nodeOk = Number(process.versions.node.split(".")[0]) >= 22;
  checks.push(
    check(
      "node",
      nodeOk,
      true,
      nodeOk
        ? process.versions.node
        : `Found ${process.versions.node}; install Node.js 22.19.0 or newer.`,
    ),
  );
  const git = await safeExecutable("/usr/bin/git");
  checks.push(
    check(
      "provider-projection-contracts",
      true,
      false,
      "Agent Board and Todo event adapters are installed. Providers are optional.",
    ),
  );
  checks.push(
    check(
      "git",
      git,
      true,
      git ? "/usr/bin/git" : "Install Git and make /usr/bin/git executable.",
    ),
  );

  const binary = options.herdrBinary ?? process.env.HERDR_BIN_PATH;
  const binaryOk = await safeExecutable(binary);
  checks.push(
    check(
      "herdr-binary",
      binaryOk,
      true,
      binaryOk
        ? "Authoritative Herdr binary is executable."
        : "HERDR_BIN_PATH is missing or unsafe. Upgrade to Herdr 0.8.2 or newer and run this command inside its managed pane.",
    ),
  );

  let identity: Awaited<ReturnType<typeof canonicalHerdrSocket>> | undefined;
  try {
    identity = await canonicalHerdrSocket(
      options.herdrSocket ?? process.env.HERDR_SOCKET_PATH,
    );
    checks.push(
      check("herdr-socket", true, true, "canonical owner-only socket"),
    );
  } catch (error) {
    checks.push(
      check(
        "herdr-socket",
        false,
        true,
        error instanceof Error
          ? error.message
          : "Start this command inside a supported Herdr pane.",
      ),
    );
  }

  let schema = options.schema;
  if (schema === undefined && binaryOk) {
    try {
      schema = await new HerdrApi({ binaryPath: binary! }).readSchema();
    } catch {
      schema = undefined;
    }
  }
  if (schema !== undefined) {
    const api = new HerdrApi({
      runner: async () => ({
        stdout: JSON.stringify(schema),
        stderr: "",
        exitCode: 0,
      }),
    });
    const schemaValid = await api.readSchema().then(
      () => true,
      () => false,
    );
    checks.push(
      check(
        "herdr-schema",
        schemaValid,
        true,
        schemaValid
          ? "Herdr API schema is valid."
          : "Herdr API schema is incompatible. Upgrade to the documented Herdr minimum.",
      ),
    );
    for (const method of [
      "session.snapshot",
      "events.subscribe",
      "tab.create",
      "tab.close",
      "agent.start",
      "worktree.create",
      "worktree.remove",
    ]) {
      const available = api.supports(method);
      checks.push(
        check(
          `herdr-capability:${method}`,
          available,
          true,
          available
            ? "supported"
            : `Herdr does not provide required method ${method}.`,
        ),
      );
    }
  } else {
    checks.push(
      check(
        "herdr-schema",
        false,
        true,
        "Run inside Herdr 0.8.2 or newer with an injected absolute HERDR_BIN_PATH.",
      ),
    );
  }

  if (identity) {
    const paths = resolvePaths(identity.path);
    for (const [name, path] of [
      ["state-path", paths.root],
      ["runtime-path", paths.runtime],
    ] as const) {
      let safe = false;
      try {
        await ensurePrivateDirectory(path);
        safe = true;
      } catch {
        safe = false;
      }
      checks.push(
        check(
          name,
          safe,
          true,
          safe
            ? "owner-only directory"
            : `Make ${name} an owner-only real directory and retry.`,
        ),
      );
    }
    const retention = await new HerdrProvisioner(
      {} as never,
      join(paths.root, "prompts"),
    ).registrationRetentionStatus();
    const retentionCurrent =
      retention.unsafeFiles === 0 &&
      retention.files <= retention.maxFiles &&
      retention.bytes <= retention.maxBytes &&
      (retention.oldestMtimeMs === undefined ||
        Date.now() - retention.oldestMtimeMs <= retention.maxAgeMs);
    checks.push(
      check(
        "registration-retention",
        retentionCurrent,
        false,
        `${retention.files}/${retention.maxFiles} files; ${retention.bytes}/${retention.maxBytes} bytes; ${retention.unsafeFiles} unsafe`,
      ),
    );
  }

  return {
    version: "0.1.0",
    platform: process.platform,
    node: process.versions.node,
    checks,
    ok: checks.every((item) => !item.mandatory || item.available),
  };
}
function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maxBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
export function validateDoctorReport(value: unknown): DoctorReport {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Broker returned an invalid doctor report.");
  const report = value as Record<string, unknown>;
  if (
    Object.keys(report).length !== 5 ||
    !["version", "platform", "node", "checks", "ok"].every((key) =>
      Object.hasOwn(report, key),
    ) ||
    !boundedText(report.version, 64) ||
    !boundedText(report.platform, 64) ||
    !boundedText(report.node, 64) ||
    typeof report.ok !== "boolean" ||
    !Array.isArray(report.checks) ||
    report.checks.length > 64
  )
    throw new Error("Broker returned an invalid doctor report.");
  const checks = report.checks.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Broker returned an invalid doctor report.");
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).length !== 4 ||
      !["name", "available", "mandatory", "detail"].every((key) =>
        Object.hasOwn(item, key),
      ) ||
      !boundedText(item.name, 128) ||
      !boundedText(item.detail, 1024) ||
      typeof item.available !== "boolean" ||
      typeof item.mandatory !== "boolean"
    )
      throw new Error("Broker returned an invalid doctor report.");
    return {
      name: item.name,
      available: item.available,
      mandatory: item.mandatory,
      detail: item.detail,
    };
  });
  if (report.ok !== checks.every((item) => !item.mandatory || item.available))
    throw new Error("Broker returned an invalid doctor report.");
  return {
    version: report.version,
    platform: report.platform,
    node: report.node,
    checks,
    ok: report.ok,
  };
}
export function unavailableDoctorReport(): DoctorReport {
  return {
    version: "0.1.0",
    platform: process.platform,
    node: process.versions.node,
    checks: [
      {
        name: "broker",
        available: false,
        mandatory: true,
        detail: "Authenticated session broker is unavailable.",
      },
    ],
    ok: false,
  };
}
export function doctorJson(report: DoctorReport): string {
  return JSON.stringify(report);
}
