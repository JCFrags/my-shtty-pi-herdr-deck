import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { encodeFrame, NdjsonDecoder } from "../../src/shared/protocol/codec.js";
import type { Agent, Task } from "../../src/state/types.js";
import type { DeckEvent, DeckSnapshot } from "../../src/deck/types.js";

export const m6Snapshot: DeckSnapshot = {
  seq: 10,
  agents: [
    {
      id: "agt_alpha",
      state: "working",
      generation: 2,
      displayName: "Alpha",
      paneId: "pane-alpha",
      terminalId: "term-main",
      currentRunId: "run-1",
      coarseStatus: "working",
    },
  ],
  tasks: [
    {
      id: "tsk_build",
      title: "Build deck",
      objective: "Exercise the deck integration surfaces.",
      state: "running",
      createdAt: "2026-08-10T15:00:00.000Z",
      currentRunId: "run-1",
    },
  ],
  runs: [
    {
      id: "run-1",
      taskId: "tsk_build",
      agentId: "agt_alpha",
      state: "working",
      assignmentGeneration: 2,
      settled: false,
    },
  ],
  workflows: [],
  providerProjections: [
    {
      ownerAgentId: "agt_alpha",
      piSessionId: "pi-alpha",
      agentBoard: {
        available: true,
        openCount: 1,
        items: [{ id: "board-1", title: "Review release?", state: "open" }],
      },
      todo: {
        available: true,
        total: 2,
        completed: 1,
        items: [{ id: "todo-1", text: "Build deck", status: "working" }],
      },
    },
  ],
};

export const m6Event = (
  seq: number,
  id: string,
  event: string,
  refs: Record<string, string>,
  data: unknown,
): DeckEvent => ({ seq, id, event, refs, data });

export class FakeDeckSocket extends EventEmitter {
  readonly writes: unknown[] = [];
  readonly #decoder = new NdjsonDecoder<unknown>((value) => value);
  #closed = false;
  onWrite?: (frame: Record<string, unknown>, socket: FakeDeckSocket) => void;

  write(chunk: Uint8Array, callback?: (error?: Error) => void): boolean {
    for (const item of this.#decoder.push(Buffer.from(chunk)))
      if (item.ok) {
        this.writes.push(item.value);
        this.onWrite?.(item.value as Record<string, unknown>, this);
      }
    callback?.();
    return true;
  }

  send(frame: unknown): void {
    if (!this.#closed) this.emit("data", encodeFrame(frame));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close");
  }

  destroy(): this {
    this.close();
    return this;
  }
}

export class FakeDeckBroker {
  readonly sockets: FakeDeckSocket[] = [];
  readonly requests: Record<string, unknown>[] = [];
  readonly helloFrames: Record<string, unknown>[] = [];
  readonly #snapshot: DeckSnapshot;
  #nextEventSeq: number;

  constructor(snapshot: DeckSnapshot = m6Snapshot) {
    this.#snapshot = snapshot;
    this.#nextEventSeq = snapshot.seq;
  }

  createSocket(): Socket {
    const socket = new FakeDeckSocket();
    socket.onWrite = (frame) => {
      if (frame.type === "hello") {
        this.helloFrames.push(frame);
        queueMicrotask(() =>
          socket.send({ type: "hello_result", id: frame.id, ok: true }),
        );
      } else if (frame.type === "request") {
        this.requests.push(frame);
        if (frame.method === "events.subscribe")
          queueMicrotask(() =>
            socket.send({
              type: "response",
              id: frame.id,
              ok: true,
              result: { snapshot: this.#snapshot },
            }),
          );
        else
          queueMicrotask(() =>
            socket.send({
              type: "response",
              id: frame.id,
              ok: true,
              result: { ok: true },
            }),
          );
      }
    };
    this.sockets.push(socket);
    return socket as unknown as Socket;
  }

  publish(event: DeckEvent): void {
    this.#nextEventSeq = Math.max(this.#nextEventSeq, event.seq);
    this.sockets.at(-1)?.send({ type: "event", ...event });
  }

  nextEvent(event: Omit<DeckEvent, "seq">): DeckEvent {
    this.#nextEventSeq += 1;
    return { ...event, seq: this.#nextEventSeq };
  }
}

export const agentTarget = (
  agent: Agent = m6Snapshot.agents[0]!,
): {
  agent: Agent;
  paneId: string;
  terminalId: string;
  sessionId: string;
  generation: number;
} => ({
  agent,
  paneId: agent.paneId!,
  terminalId: agent.terminalId!,
  sessionId: "session-main",
  generation: agent.generation,
});

export const taskTarget = (task: Task = m6Snapshot.tasks[0]!) => ({ task });

export async function waitForM6(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for M6 fixture state.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
