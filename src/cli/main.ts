import { doctor } from "../broker/doctor.js";
import { Broker } from "../broker/broker.js";
import { ensurePrivateDirectory, resolvePaths } from "../shared/paths.js";
import { brokerRequest } from "./client.js";
import { readPrivateRegular } from "../shared/private-fs.js";
import { createProductionHerdrService } from "../herdr/service.js";
import { loadConfig } from "../ops/config.js";
import { exportState, planRetention } from "../ops/retention.js";
async function openStore(broker: Broker): Promise<void> {
  const snapshot = await broker.readSnapshot().catch((error: unknown) => {
    broker.store.readOnly = true;
    broker.store.corruption =
      error instanceof Error ? error.message : "Snapshot verification failed.";
    return undefined;
  });
  await broker.store.open(snapshot);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command, subcommand] = argv;
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
    console.log(JSON.stringify({ valid: true, version: config.version }));
    return;
  }
  if (command === "retention" && subcommand === "plan") {
    console.log(JSON.stringify(await planRetention(paths.root)));
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
    "Usage: doctor [--json] | broker start|status | events verify | config validate PATH | retention plan | export --output DIR | version",
  );
  process.exitCode = 2;
}
