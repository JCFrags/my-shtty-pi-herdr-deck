import { Buffer } from "node:buffer";
import { LIMITS } from "../limits.js";
export class ProtocolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export function encodeFrame(value: unknown): Buffer {
  const line = `${JSON.stringify(value)}\n`;
  const bytes = Buffer.byteLength(line);
  if (bytes > LIMITS.maxLineBytes)
    throw new ProtocolError(
      "FRAME_TOO_LARGE",
      "Frame exceeds the maximum size.",
    );
  return Buffer.from(line);
}
export class NdjsonDecoder<T> {
  #buffer = Buffer.alloc(0);
  #discard = false;
  constructor(readonly validate: (value: unknown) => T) {}
  push(
    chunk: Buffer | string,
  ): Array<{ ok: true; value: T } | { ok: false; error: ProtocolError }> {
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const output: Array<
      { ok: true; value: T } | { ok: false; error: ProtocolError }
    > = [];
    let start = 0;
    while (start < input.length) {
      const end = input.indexOf(10, start);
      const stop = end < 0 ? input.length : end;
      const part = input.subarray(start, stop);
      if (this.#discard) {
        if (end >= 0) this.#discard = false;
      } else if (this.#buffer.length + part.length > LIMITS.maxLineBytes) {
        this.#buffer = Buffer.alloc(0);
        output.push({
          ok: false,
          error: new ProtocolError(
            "FRAME_TOO_LARGE",
            "Frame exceeds the maximum size.",
          ),
        });
        if (end < 0) this.#discard = true;
      } else {
        this.#buffer = Buffer.concat([this.#buffer, part]);
        if (end >= 0) {
          const line = this.#buffer;
          this.#buffer = Buffer.alloc(0);
          if (line.length) {
            try {
              output.push({
                ok: true,
                value: this.validate(JSON.parse(line.toString("utf8"))),
              });
            } catch (error) {
              output.push({
                ok: false,
                error:
                  error instanceof ProtocolError
                    ? error
                    : new ProtocolError("MALFORMED_FRAME", "Frame is invalid."),
              });
            }
          }
        }
      }
      start = end < 0 ? input.length : end + 1;
    }
    return output;
  }
}
