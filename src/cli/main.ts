import { doctor } from "../broker/doctor.js";
import { Broker } from "../broker/broker.js";
import { ensurePrivateDirectory, resolvePaths } from "../shared/paths.js";
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
    await broker.store.open();
    console.log(
      JSON.stringify({
        status: "healthy",
        eventSeq: broker.store.state.lastEventSeq,
      }),
    );
    return;
  }
  if (command === "events" && subcommand === "verify") {
    await broker.store.open();
    console.log(JSON.stringify(broker.store.verify()));
    return;
  }
  console.error(
    "Usage: pi-herdr-orchestrator doctor [--json] | broker start|status | events verify | version",
  );
  process.exitCode = 2;
}
