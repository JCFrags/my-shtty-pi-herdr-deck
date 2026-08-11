import { doctor } from "../broker/doctor.js";
import { Broker } from "../broker/broker.js";
import { ensurePrivateDirectory, resolvePaths } from "../shared/paths.js";
import { brokerRequest } from "./client.js";
import { readPrivateRegular } from "../shared/private-fs.js";
import { createProductionHerdrService } from "../herdr/service.js";
import { loadConfig } from "../ops/config.js";
import { exportState, planRetention } from "../ops/retention.js";
import { planRetention as planRetentionPolicy } from "../ops/retention-policy.js";
import { exportBeforeRepair, planRecovery } from "../ops/recovery.js";
import { ConfigPolicy } from "../ops/config-policy.js";
import {
  createOperationPlan,
  createRollbackRecord,
  loadCurrentEvidence,
  loadOperationPlan,
  verifyOperationPlan,
  type OperatorResource,
} from "../ops/operator-actions.js";
async function openStore(broker: Broker): Promise<void> {
  const snapshot = await broker.readSnapshot().catch((error: unknown) => {
    broker.store.readOnly = true;
    broker.store.corruption =
      error instanceof Error ? error.message : "Snapshot verification failed.";
    return undefined;
  });
  await broker.store.open(snapshot);
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function operationResource(value: string): OperatorResource {
  const [id, identity, state] = value.split(":");
  if (!id || !identity || !state)
    throw new Error("Resource must be ID:IDENTITY:clean.");
  if (state !== "clean")
    throw new Error("Only clean resources may enter an operation plan.");
  return { id, identity, state };
}

function operationEvidence(value: string): { name: string; digest: string } {
  const [name, digest] = value.split(":");
  if (!name || !digest) throw new Error("Evidence must be NAME:SHA256.");
  return { name, digest };
}

async function runDeck(): Promise<void> {
  const { main: deckMain } = await import("../deck/main.js");
  await deckMain();
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, subcommand] = argv;
  if (command === "deck") {
    await runDeck();
    return;
  }
  if (command === "version") {
    console.log("0.1.0");
    return;
  }
  if (command === "doctor") {
    const report = await doctor();
    console.log(
      argv.includes("--json")
        ? JSON.stringify(report)
        : report.checks
            .map((c) => `${c.available ? "ok" : "FAIL"} ${c.name}: ${c.detail}`)
            .join("\n"),
    );
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const paths = resolvePaths();
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.runtime);
  if (command === "config" && subcommand === "validate") {
    const file = argv[2] ?? process.env.PI_HERDR_ORCH_CONFIG_PATH;
    if (!file) throw new Error("Usage: config validate PATH.");
    const config = await loadConfig(file, {
      trustedProject: process.env.PI_HERDR_ORCH_PROJECT_TRUSTED === "1",
    });
    const policy = new ConfigPolicy({ user: config });
    console.log(
      JSON.stringify({
        valid: true,
        version: config.version,
        generation: policy.snapshot.generation,
        hash: policy.snapshot.hash,
      }),
    );
    return;
  }
  if (
    command === "retention" &&
    (subcommand === "plan" || subcommand === "policy-plan")
  ) {
    if (subcommand === "plan") {
      console.log(JSON.stringify(await planRetention(paths.root)));
      return;
    }
    const resourcesFile = option(argv, "--resources");
    if (!resourcesFile)
      throw new Error("Usage: retention policy-plan --resources PATH.");
    const resources = JSON.parse(
      await readPrivateRegular(resourcesFile),
    ) as Parameters<typeof planRetentionPolicy>[0];
    const now = Number(option(argv, "--now") ?? Date.now());
    const maxAge = Number(option(argv, "--max-age-ms") ?? 7 * 86_400_000);
    const maxBytes = Number(
      option(argv, "--max-bytes") ?? Number.MAX_SAFE_INTEGER,
    );
    console.log(
      JSON.stringify(
        planRetentionPolicy(resources, {
          now,
          maxAgeMs: { artifact: maxAge, log: maxAge },
          maxBytes: { artifact: maxBytes, log: maxBytes },
          maxItems: Number(option(argv, "--max-items") ?? 10_000),
        }),
      ),
    );
    return;
  }
  if (
    command === "ops" &&
    (subcommand === "plan" || subcommand === "verify" || subcommand === "apply")
  ) {
    if (subcommand === "plan") {
      const action = option(argv, "--action") as
        "deploy" | "restart" | "rollback" | undefined;
      const expectedCommit = option(argv, "--commit");
      const rollbackCommit = option(argv, "--rollback");
      const evidence = option(argv, "--evidence");
      const generation = Number(option(argv, "--state-generation") ?? "0");
      if (!action || !expectedCommit || !rollbackCommit || !evidence)
        throw new Error(
          "Usage: ops plan --action ACTION --commit COMMIT --rollback COMMIT --evidence NAME:SHA256 [--resource ID:IDENTITY:clean].",
        );
      const resources: OperatorResource[] = [];
      for (let index = 0; index < argv.length; index++)
        if (argv[index] === "--resource")
          resources.push(operationResource(argv[index + 1] ?? ""));
      const plan = createOperationPlan({
        action,
        expectedCommit,
        expectedResources: resources,
        preflight: [operationEvidence(evidence)],
        timeoutMs: Number(option(argv, "--timeout-ms") ?? "30000"),
        rollback: createRollbackRecord({
          candidateCommit: expectedCommit,
          rollbackCommit,
          stateGeneration: generation,
          resourceIdentities: resources.map((resource) => resource.identity),
        }),
      });
      console.log(JSON.stringify(plan));
      return;
    }
    const planPath = option(argv, "--plan");
    const currentPath = option(argv, "--current");
    if (!planPath || !currentPath)
      throw new Error(
        "Usage: ops verify|apply --plan EXPECTED.json --current CURRENT.json.",
      );
    const plan = await loadOperationPlan(planPath);
    const current = await loadCurrentEvidence(currentPath);
    const verification = verifyOperationPlan(
      plan,
      current.commit,
      current.resources,
      current.preflight,
    );
    if (subcommand === "verify") {
      console.log(JSON.stringify({ ...verification, executionEnabled: false }));
      if (!verification.ok) process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify({
        applied: false,
        executionEnabled: false,
        verification,
        reason: "CLI apply is disabled; use an injected runner in tests.",
      }),
    );
    if (!verification.ok) process.exitCode = 1;
    return;
  }
  if (command === "export") {
    const outputFlag = argv.indexOf("--output");
    const output = outputFlag >= 0 ? argv[outputFlag + 1] : undefined;
    if (!output) throw new Error("Usage: export --output DIRECTORY.");
    console.log(JSON.stringify(await exportState(paths, output)));
    return;
  }
  if (command === "herdr") {
    const method =
      subcommand === "status"
        ? "herdr.status"
        : subcommand === "reconcile"
          ? "herdr.reconcile"
          : (subcommand ?? "");
    if (
      ![
        "herdr.status",
        "herdr.reconcile",
        "herdr.focus",
        "herdr.interrupt",
        "herdr.stop",
        "herdr.adopt",
        "herdr.register",
        "herdr.close",
        "herdr.provision",
      ].includes(method)
    ) {
      console.error(
        "Usage: herdr status|reconcile|focus|interrupt|stop|adopt|register|close|provision",
      );
      process.exitCode = 2;
      return;
    }
    let params: Record<string, unknown> = {};
    if (
      ["herdr.focus", "herdr.interrupt", "herdr.stop", "herdr.close"].includes(
        method,
      )
    ) {
      const paneId = argv[2];
      if (!paneId || /[\u0000-\u001f\u007f]/u.test(paneId))
        throw new Error("Pane ID is invalid.");
      params = { paneId };
      if (argv[3]) params.terminalId = argv[3];
      if (argv[4]) params.sessionId = argv[4];
      if (argv[5]) params.generation = Number(argv[5]);
    } else if (
      method === "herdr.provision" ||
      method === "herdr.adopt" ||
      method === "herdr.register"
    ) {
      const file = argv[2];
      if (!file) throw new Error("Provisioning requires --params-file PATH.");
      params = JSON.parse(await readPrivateRegular(file)) as Record<
        string,
        unknown
      >;
    }
    console.log(
      JSON.stringify(
        await brokerRequest(paths.socket, paths.secret, method, params),
      ),
    );
    return;
  }
  const broker = new Broker(
    paths,
    process.env.HERDR_BIN_PATH
      ? {
          herdrFactory: (store, resolved) =>
            createProductionHerdrService(store, resolved),
        }
      : {},
  );
  if (
    command === "recovery" &&
    (subcommand === "plan" || subcommand === "export")
  ) {
    await openStore(broker);
    const verification = await broker.store.verifyDisk();
    const recovery = planRecovery({ verification });
    if (subcommand === "plan") {
      console.log(JSON.stringify(recovery));
      return;
    }
    const output = option(argv, "--output");
    if (!output) throw new Error("Usage: recovery export --output DIRECTORY.");
    console.log(
      JSON.stringify(await exportBeforeRepair(paths, output, { verification })),
    );
    return;
  }
  if (command === "broker" && subcommand === "start") {
    await broker.start();
    console.log(JSON.stringify({ status: "started", socket: paths.socket }));
    return;
  }
  if (command === "broker" && subcommand === "status") {
    await openStore(broker);
    console.log(
      JSON.stringify({
        status: broker.store.readOnly ? "read_only_recovery" : "healthy",
        eventSeq: broker.store.state.lastEventSeq,
        ...(broker.store.corruption
          ? { corruption: broker.store.corruption }
          : {}),
      }),
    );
    return;
  }
  if (command === "events" && subcommand === "verify") {
    await openStore(broker);
    console.log(JSON.stringify(await broker.store.verifyDisk()));
    return;
  }
  console.error(
    "Usage: deck | doctor [--json] | broker start|status | events verify | config validate PATH | recovery plan|export | retention plan|policy-plan | ops plan|verify|apply | export --output DIR | version",
  );
  process.exitCode = 2;
}
