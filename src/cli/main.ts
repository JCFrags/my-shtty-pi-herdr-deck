import { doctor } from "../broker/doctor.js";
import { Broker } from "../broker/broker.js";
import { ensurePrivateDirectory, resolvePaths } from "../shared/paths.js";
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
  const broker = new Broker(paths);
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
