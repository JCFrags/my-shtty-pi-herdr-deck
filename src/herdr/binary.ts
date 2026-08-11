import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface HerdrBinaryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  uid: bigint;
  ctimeNs: bigint;
}

export async function authoritativeHerdrBinary(
  value = process.env.HERDR_BIN_PATH,
): Promise<HerdrBinaryIdentity> {
  if (!value)
    throw new Error("HERDR_UNAVAILABLE: HERDR_BIN_PATH is not configured.");
  if (
    !isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    resolve(value) !== value
  )
    throw new Error("HERDR_BIN_PATH must be a canonical absolute path.");
  const canonical = await realpath(value).catch(() => "");
  const stat = await lstat(value, { bigint: true }).catch(() => undefined);
  const uid = process.getuid?.();
  if (
    canonical !== value ||
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    (uid !== undefined && stat.uid !== 0n && stat.uid !== BigInt(uid)) ||
    (stat.mode & 0o022n) !== 0n ||
    (stat.mode &
      BigInt(constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) ===
      0n
  )
    throw new Error("HERDR_BIN_PATH is missing, replaced, or unsafe.");
  return {
    path: value,
    dev: stat.dev,
    ino: stat.ino,
    uid: stat.uid,
    ctimeNs: stat.ctimeNs,
  };
}

export async function revalidateHerdrBinary(
  expected: HerdrBinaryIdentity,
): Promise<void> {
  const current = await authoritativeHerdrBinary(expected.path);
  if (
    current.dev !== expected.dev ||
    current.ino !== expected.ino ||
    current.uid !== expected.uid ||
    current.ctimeNs !== expected.ctimeNs
  )
    throw new Error("HERDR_BIN_PATH changed after broker startup.");
}
