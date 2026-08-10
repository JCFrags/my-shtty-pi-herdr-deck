import { createHash, randomBytes } from "node:crypto";
const CONTROL = /[\u0000-\u001f\u007f]/u;
export function slug(value: string, fallback = "agent"): string {
  if (CONTROL.test(value)) throw new Error("Name contains control characters.");
  const s = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (s || fallback).replace(/^[^a-z]+/, "a");
}
export function herdrName(
  role: string,
  id: string,
  live: Iterable<string> = [],
): string {
  const base = slug(role),
    tail = /^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$/u.test(id)
      ? id.slice(id.indexOf("_") + 1, id.indexOf("_") + 9).toLowerCase()
      : createHash("sha256").update(id).digest("hex");
  let n = `pi-${base}-${tail.slice(0, 8)}`.slice(0, 32);
  const used = new Set(live);
  let i = 8;
  while (used.has(n) && i < tail.length) {
    n = `pi-${base}-${tail.slice(i, i + 8)}`.slice(0, 32);
    i += 8;
  }
  if (used.has(n)) throw new Error("No available Herdr name.");
  return n;
}
export function label(value: string, max = 80): string {
  if (CONTROL.test(value))
    throw new Error("Label contains control characters.");
  return value.trim().slice(0, max);
}
export function branchSlug(value: string, max = 48): string {
  const s = slug(value, "task")
    .replace(/-+/g, "-")
    .slice(0, max)
    .replace(/-$/u, "");
  return s || "task";
}
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
