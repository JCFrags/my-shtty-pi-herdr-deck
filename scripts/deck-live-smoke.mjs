#!/usr/bin/env node

// This read-only live smoke is opt-in. It never sends a lifecycle control.
if (process.env.PI_HERDR_DECK_LIVE_SMOKE !== "1") {
  console.error(
    "Refusing to run. Set PI_HERDR_DECK_LIVE_SMOKE=1 and PI_HERDR_ORCH_BROKER_SOCKET explicitly.",
  );
  process.exitCode = 2;
} else {
  const socketPath = process.env.PI_HERDR_ORCH_BROKER_SOCKET;
  if (!socketPath) {
    console.error("PI_HERDR_ORCH_BROKER_SOCKET is required.");
    process.exitCode = 2;
  } else {
    const timeoutMs = Math.min(
      30_000,
      Math.max(
        1_000,
        Number(process.env.PI_HERDR_DECK_SMOKE_TIMEOUT_MS ?? 10_000),
      ),
    );
    const [{ BrokerClient }, views] = await Promise.all([
      import("../dist/src/deck/broker-client.js"),
      import("../dist/src/deck/views.js"),
    ]);
    const client = new BrokerClient({
      socketPath,
      ...(process.env.PI_HERDR_ORCH_CLIENT_SECRET_PATH
        ? { secretPath: process.env.PI_HERDR_ORCH_CLIENT_SECRET_PATH }
        : {}),
      clientName: "pi-herdr-deck-live-smoke",
      reconnectDelaysMs: [],
    });
    try {
      await client.start();
      await client.waitForReady(timeoutMs);
      const state = client.store.state;
      const output = [
        ...views.renderAgents(state, 160),
        ...views.renderGroups(state, 160),
        ...views.renderTasks(state, 160),
        ...views.renderQuestions([...state.questions.values()], 160),
      ].join("\n");
      if (
        !output.includes("AGENTS") ||
        !output.includes("GROUPS") ||
        !output.includes("TASKS")
      )
        throw new Error("Deck render headings are incomplete.");
      console.log(output);
      console.log(
        JSON.stringify({
          ok: true,
          seq: state.seq,
          agents: state.agents.size,
          groups: state.groups.size,
          tasks: state.tasks.size,
          questions: state.questions.size,
          results: state.results.size,
          controlsSent: 0,
        }),
      );
    } catch (error) {
      console.error(
        `Deck live smoke failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    } finally {
      client.stop("Deck live smoke complete.");
    }
  }
}
