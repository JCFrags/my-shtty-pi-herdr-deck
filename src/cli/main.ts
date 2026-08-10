import { doctor } from "../broker/doctor.js";
import { Broker } from "../broker/broker.js";
import { ensurePrivateDirectory, resolvePaths } from "../shared/paths.js";
import { brokerRequest } from "./client.js";
import { readPrivateRegular } from "../shared/private-fs.js";
import { createProductionHerdrService } from "../herdr/service.js";
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
    "Usage: pi-herdr-orchestrator doctor [--json] | broker start|status | events verify | version",
  );
  process.exitCode = 2;
}
