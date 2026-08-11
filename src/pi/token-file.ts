import { readPrivateRegular } from "../shared/private-fs.js";
import { dirname, join } from "node:path";

const MAX_TOKEN_FILE_BYTES = 4096;
const MAX_TOKEN_BYTES = 2048;
export function siblingSecretPath(socketPath: string): string {
  if (
    !socketPath ||
    socketPath.length > 4096 ||
    !socketPath.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(socketPath) ||
    !socketPath.endsWith(".sock")
  )
    throw new Error("PI_SOCKET_PATH_INVALID");
  return join(dirname(socketPath), "client.secret");
}

export async function readBrokerSecretFile(path: string): Promise<string> {
  const value = await readPrivateRegular(path);
  if (
    Buffer.byteLength(value, "utf8") > 2048 ||
    !/^[A-Za-z0-9_-]{43}\n$/u.test(value)
  )
    throw new Error("PI_BROKER_SECRET_INVALID");
  return value.slice(0, -1);
}

export async function readManagedTokenFile(path: string): Promise<string> {
  if (
    !path ||
    path.length > MAX_TOKEN_FILE_BYTES ||
    !path.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(path)
  )
    throw new Error("PI_TOKEN_FILE_INVALID");
  let value: string;
  try {
    value = await readPrivateRegular(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR")
      throw new Error("PI_TOKEN_FILE_INVALID");
    throw error;
  }
  if (
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_FILE_BYTES ||
    !/^[A-Za-z0-9_-]{32,2048}\n?$/u.test(value) ||
    value.trimEnd().length > MAX_TOKEN_BYTES
  )
    throw new Error("PI_TOKEN_FILE_INVALID");
  return value.trimEnd();
}
