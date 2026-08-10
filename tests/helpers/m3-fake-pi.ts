import type {
  PiApiLike,
  PiContextLike,
  PiLifecycleEvent,
  PiModelLike,
} from "../../src/pi/types.js";
import { PiAdapter } from "../../src/pi/adapter.js";

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
