import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, lstat, readFile, unlink } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { LIMITS } from "../shared/limits.js";
import { createId } from "../shared/ids.js";
import { OrchestratorError } from "../shared/errors.js";
export interface ArtifactRef {
  id: string;
  kind: "text" | "json" | "patch" | "log" | "report" | "other";
  relativePath: string;
  byteLength: number;
  sha256: string;
  mediaType: string;
  createdAt: string;
  expiresAt?: string;
}
export class ArtifactStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  async put(input: {
    kind: ArtifactRef["kind"];
    name: string;
    content: string | Uint8Array;
    mediaType: string;
    ttlMs?: number;
  }): Promise<ArtifactRef> {
    const name = basename(input.name);
    if (
      name !== input.name ||
      name === "." ||
      name === ".." ||
      name.includes("\\") ||
      input.content.length > LIMITS.maxArtifactBytes
    )
      throw new OrchestratorError(
        "LIMIT_EXCEEDED",
        "Artifact path or size is invalid.",
      );
    if (!input.mediaType || input.mediaType.length > 128)
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Artifact media type is invalid.",
      );
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const id = createId("art");
    const path = join(this.root, `${id}-${name}`);
    const bytes =
      typeof input.content === "string"
        ? Buffer.from(input.content)
        : Buffer.from(input.content);
    const handle = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const createdAt = new Date().toISOString();
    const expiresAt =
      input.ttlMs === undefined
        ? undefined
        : new Date(Date.now() + input.ttlMs).toISOString();
    return {
      id,
      kind: input.kind,
      relativePath: relative(this.root, path),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mediaType: input.mediaType,
      createdAt,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  async read(
    ref: ArtifactRef,
    offset = 0,
    limit = 64 * 1024,
  ): Promise<{ content: Buffer; sha256: string }> {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > LIMITS.maxArtifactBytes
    )
      throw new OrchestratorError(
        "LIMIT_EXCEEDED",
        "Artifact read bounds are invalid.",
      );
    const path = resolve(this.root, ref.relativePath);
    if (
      relative(this.root, path).startsWith("..") ||
      !relative(this.root, path)
    )
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Artifact path escapes its owner root.",
      );
    const stat = await lstat(path).catch(() => {
      throw new OrchestratorError("NOT_FOUND", "Artifact was not found.");
    });
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0
    )
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Artifact is not a safe private file.",
      );
    const bytes = await readFile(path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== ref.sha256 || bytes.length !== ref.byteLength)
      throw new OrchestratorError(
        "STATE_CORRUPT",
        "Artifact digest does not match its reference.",
      );
    return {
      content: bytes.subarray(offset, Math.min(bytes.length, offset + limit)),
      sha256: digest,
    };
  }
  async expire(ref: ArtifactRef): Promise<void> {
    const path = resolve(this.root, ref.relativePath);
    if (relative(this.root, path).startsWith(".."))
      throw new OrchestratorError(
        "INVALID_REQUEST",
        "Artifact path escapes its owner root.",
      );
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
