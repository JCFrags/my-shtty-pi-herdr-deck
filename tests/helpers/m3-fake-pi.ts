import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PiApiLike,
  PiContextLike,
  PiLifecycleEvent,
  PiModelLike,
} from "../../src/pi/types.js";
import { PiAdapter } from "../../src/pi/adapter.js";
import { encodeFrame } from "../../src/shared/protocol/codec.js";

const model: PiModelLike = {
  provider: "fake",
  id: "fake-model",
  name: "Fake model",
};

export class FakePi {
  readonly sentMessages: string[] = [];
  readonly adapter: PiAdapter;
  readonly api: PiApiLike;
  readonly context: PiContextLike;
  #idle = true;
  #pendingMessages = false;
  #promptGate: Promise<void> | undefined;
  #releasePrompt: (() => void) | undefined;

  constructor(agentId: string, generation: number, sessionId: string) {
    this.api = {
      on: () => undefined,
      registerCommand: () => undefined,
      sendUserMessage: async (content: string): Promise<void> => {
        this.sentMessages.push(content);
        if (this.#promptGate) await this.#promptGate;
      },
      setModel: () => true,
      setThinkingLevel: () => undefined,
      getAllowedThinkingLevels: () => ["low", "medium", "high"],
      getActiveTools: () => [],
      getAllTools: () => [],
    };
    this.context = {
      ui: {},
      cwd: "/tmp/fake-pi",
      sessionManager: { getSessionId: () => sessionId },
      modelRegistry: { find: () => model },
      model,
      thinkingLevel: "medium",
      isIdle: () => this.#idle,
      hasPendingMessages: () => this.#pendingMessages,
      abort: () => {
        this.#idle = true;
      },
      compact: (options) => options?.onComplete?.(),
    };
    this.adapter = new PiAdapter(this.api, this.context, agentId, generation);
  }

  setIdle(idle: boolean): void {
    this.#idle = idle;
  }

  setPendingMessages(pending: boolean): void {
    this.#pendingMessages = pending;
  }

  blockPrompt(): void {
    if (this.#promptGate) throw new Error("PROMPT_ALREADY_BLOCKED");
    this.#promptGate = new Promise<void>((resolve) => {
      this.#releasePrompt = resolve;
    });
  }

  releasePrompt(): void {
    const release = this.#releasePrompt;
    this.#releasePrompt = undefined;
    this.#promptGate = undefined;
    release?.();
  }

  lifecycle(event: PiLifecycleEvent): ReturnType<PiAdapter["onLifecycle"]> {
    return this.adapter.onLifecycle(event);
  }
}

export function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error("PI_ASSIGNMENT_TIMEOUT")),
        timeoutMs,
      ).unref();
    }),
  ]);
}

export class FakePiBroker {
  readonly requests: Record<string, unknown>[] = [];
  readonly path: string;
  #server: Server | undefined;
  #root: string | undefined;
  #helloCount = 0;

  private constructor(path: string, root: string) {
    this.path = path;
    this.#root = root;
  }

  static async start(): Promise<FakePiBroker> {
    const root = await mkdtemp(join(tmpdir(), "m3-fake-broker-"));
    const broker = new FakePiBroker(join(root, "broker.sock"), root);
    broker.#server = createServer((socket) => broker.handle(socket));
    await new Promise<void>((resolve, reject) => {
      broker.#server!.once("error", reject);
      broker.#server!.listen(broker.path, resolve);
    });
    return broker;
  }

  get helloCount(): number {
    return this.#helloCount;
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(this.#root!, { recursive: true, force: true });
    this.#server = undefined;
    this.#root = undefined;
  }

  private handle(socket: Socket): void {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.type === "hello") this.#helloCount += 1;
        if (frame.type === "hello") {
          socket.write(encodeFrame({ v: 1, type: "hello_result", id: frame.id, ok: true, broker: { version: "test", status: "healthy", lastEventSeq: 0 }, principal: { id: "prn_test", kind: "pi_child", permissions: ["read:state", "manage:self"] }, limits: { maxLineBytes: 1_048_576 } }));
        } else if (frame.type === "request") {
          this.requests.push(frame);
          const method = frame.method as string;
          socket.write(encodeFrame({ v: 1, type: "response", id: frame.id, ok: true, result: method.startsWith("agent.register_") ? { agentId: typeof (frame.params as Record<string, unknown> | undefined)?.agentId === "string" ? (frame.params as Record<string, unknown>).agentId : "agt_registered", generation: 1, connectionGeneration: 1, heartbeatMs: 5000, permissions: ["read:state"] } : { accepted: true } }));
        }
      }
    });
  }
}
