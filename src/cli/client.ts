import { connect } from "node:net";
import { readPrivateRegular } from "../shared/private-fs.js";
import { sessionKey } from "../shared/paths.js";
import { encodeFrame, NdjsonDecoder } from "../shared/protocol/codec.js";
import { createId } from "../shared/ids.js";

export async function brokerRequest(
  socketPath: string,
  secretPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const secret = (await readPrivateRegular(secretPath)).trimEnd();
  const socket = connect(socketPath);
  const response = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const requestId = createId("evt");
      const decoder = new NdjsonDecoder<Record<string, unknown>>(
        (value) => value as Record<string, unknown>,
      );
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("Broker request timed out."));
      }, 5_000);
      const finish = (error?: Error, value?: Record<string, unknown>) => {
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
            sessionKey: sessionKey(socketPath),
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
