import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

export interface HerdrSocketIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  ctimeNs: bigint;
  birthtimeNs: bigint;
}

export interface ResolvedPaths {
  root: string;
  runtime: string;
  events: string;
  snapshot: string;
  lock: string;
  startup?: string;
  pid?: string;
  socket: string;
  secret: string;
  log?: string;
  herdrSocket?: string;
  sessionKey?: string;
}

export interface CanonicalResolvedPaths extends ResolvedPaths {
  startup: string;
  pid: string;
  log: string;
  herdrSocket: string;
  sessionKey: string;
}

export function sessionKey(socketPath: string): string {
  return createHash("sha256")
    .update(Buffer.from(socketPath))
    .digest("hex")
    .slice(0, 24);
}

function safeAbsolutePath(value: string, label: string): string {
  if (
    !isAbsolute(value) ||
    value.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    resolve(value) !== value
  )
    throw new Error(`${label} must be a canonical absolute path.`);
  return value;
}

export async function canonicalHerdrSocket(
  value = process.env.HERDR_SOCKET_PATH,
): Promise<HerdrSocketIdentity> {
  if (!value)
    throw new Error(
      "HERDR_SOCKET_PATH is unavailable. Start Pi inside a supported Herdr pane.",
    );
  const path = safeAbsolutePath(value, "HERDR_SOCKET_PATH");
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new Error("HERDR_SOCKET_PATH does not name the active Herdr socket.");
  }
  if (canonical !== path)
    throw new Error(
      "HERDR_SOCKET_PATH contains a symlink or noncanonical component.",
    );
  const stat = await lstat(path, { bigint: true });
  const uid = process.getuid?.();
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (uid !== undefined && stat.uid !== BigInt(uid)) ||
    (stat.mode & 0o077n) !== 0n
  )
    throw new Error(
      "HERDR_SOCKET_PATH must be an owner-only Unix socket owned by the current user.",
    );
  return {
    path,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    ctimeNs: stat.ctimeNs,
    birthtimeNs: stat.birthtimeNs,
  };
}

export async function revalidateHerdrSocket(
  expected: HerdrSocketIdentity,
): Promise<void> {
  const current = await canonicalHerdrSocket(expected.path);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.uid !== expected.uid ||
    current.ctimeNs !== expected.ctimeNs ||
    current.birthtimeNs !== expected.birthtimeNs
  )
    throw new Error("HERDR_SOCKET_PATH changed after session resolution.");
}

export function resolvePaths(
  herdrSocket = process.env.HERDR_SOCKET_PATH ?? "herdr",
): CanonicalResolvedPaths {
  const key = sessionKey(herdrSocket);
  const stateBase =
    process.env.PI_HERDR_ORCH_STATE_ROOT ??
    join(
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
      "pi-herdr-orchestrator",
    );
  const runtimeBase =
    process.env.PI_HERDR_ORCH_RUNTIME_ROOT ??
    join(
      process.env.XDG_RUNTIME_DIR ?? tmpdir(),
      `pi-herdr-orchestrator-${process.getuid?.() ?? 0}`,
    );
  const root = join(stateBase, key);
  const runtime = join(runtimeBase, key);
  const brokerSocket = join(runtime, "broker.sock");
  if (Buffer.byteLength(brokerSocket, "utf8") > 103)
    throw new Error(
      "The canonical broker socket path exceeds the Linux limit.",
    );
  return {
    root,
    runtime,
    events: join(root, "events-v1.jsonl"),
    snapshot: join(root, "snapshot-v1.json"),
    lock: join(runtime, "broker.lock"),
    startup: join(runtime, "startup.lock"),
    pid: join(runtime, "broker.pid"),
    socket: brokerSocket,
    secret: join(runtime, "client.secret"),
    log: join(runtime, "broker.log"),
    herdrSocket,
    sessionKey: key,
  };
}

export async function resolveHerdrPaths(
  value = process.env.HERDR_SOCKET_PATH,
): Promise<{ identity: HerdrSocketIdentity; paths: CanonicalResolvedPaths }> {
  const identity = await canonicalHerdrSocket(value);
  return { identity, paths: resolvePaths(identity.path) };
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  const absolute = safeAbsolutePath(path, "Private directory");
  const root = parse(absolute).root;
  const relative = absolute.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < relative.length; index++) {
    current = join(current, relative[index]!);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unsafe private directory component: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST")
          throw mkdirError;
        const raced = await lstat(current);
        if (!raced.isDirectory() || raced.isSymbolicLink())
          throw new Error(`Unsafe private directory component: ${current}`);
      }
    }
  }
  const canonical = await realpath(absolute);
  const stat = await lstat(absolute);
  if (canonical !== absolute || !stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Unsafe private directory: ${absolute}`);
  if (process.getuid?.() !== undefined && stat.uid !== process.getuid())
    throw new Error("Private directory has the wrong owner.");
  if ((stat.mode & 0o077) !== 0)
    throw new Error("Private directory mode is unsafe.");
}

export function siblingPath(path: string, name: string): string {
  safeAbsolutePath(path, "Broker path");
  return join(dirname(path), name);
}
