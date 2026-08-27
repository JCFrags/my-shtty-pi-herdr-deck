import { connect } from "node:net";
import { readPrivateRegular } from "../shared/private-fs.js";
import { sessionKey } from "../shared/paths.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import { createId } from "../shared/ids.js";

export type BrokerRequestPhase = "connect" | "response";

export class BrokerRequestTimeoutError extends Error {
  readonly code = "BROKER_REQUEST_TIMEOUT";

  constructor(
    readonly method: string,
    readonly phase: BrokerRequestPhase,
    readonly elapsedMs: number,
    readonly timeoutMs: number,
  ) {
    super(
      `Broker request ${method} timed out after ${timeoutMs} ms while waiting for ${phase} (elapsed ${elapsedMs} ms).`,
    );
    this.name = "BrokerRequestTimeoutError";
  }
}

export interface BrokerRequestOptions {
  timeoutMs?: number;
}

export async function brokerRequest(
  socketPath: string,
  secretPath: string,
  method: string,
  params: Record<string, unknown>,
  expectedSessionKey?: string,
  options: BrokerRequestOptions = {},
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("Broker request timeout is invalid.");
  const secret = (await readPrivateRegular(secretPath)).trimEnd();
  const socket = connect(socketPath);
  const response = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const requestId = createId("evt");
      const startedAt = Date.now();
      let phase: BrokerRequestPhase = "connect";
      let settled = false;
      const decoder = new NdjsonDecoder<Record<string, unknown>>(
        (value) => value as Record<string, unknown>,
      );
      const timer = setTimeout(() => {
        finish(
          new BrokerRequestTimeoutError(
            method,
            phase,
            Date.now() - startedAt,
            timeoutMs,
          ),
        );
      }, timeoutMs);
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value!);
      };
      socket.once("error", (error) => finish(error));
      socket.on("data", (data) => {
        try {
          for (const item of decoder.push(data)) {
            if (!item.ok) continue;
            const frame = item.value;
            if (frame.id !== requestId) continue;
            finish(undefined, frame);
          }
        } catch {
          finish(new Error("Broker returned an invalid response."));
        }
      });
      socket.once("connect", () => {
        phase = "response";
        socket.write(
          encodeFrame({
            v: 1,
            type: "hello",
            id: createId("evt"),
            client: {
              kind: "cli",
              name: "pi-herdr-orchestrator",
              version: "0.1.0",
              capabilities: [],
            },
            sessionKey: expectedSessionKey ?? sessionKey(socketPath),
            auth: { kind: "client_secret", secret },
          }),
        );
        socket.write(
          encodeFrame({ v: 1, type: "request", id: requestId, method, params }),
        );
      });
    },
  );
  if (response.ok !== true) {
    const error = response.error as Record<string, unknown> | undefined;
    throw new Error(
      typeof error?.message === "string"
        ? error.message
        : "Broker request failed.",
    );
  }
  return response.result;
}
