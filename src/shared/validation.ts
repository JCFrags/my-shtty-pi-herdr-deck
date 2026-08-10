import { LIMITS } from "./limits.js";
export function validateText(
  value: unknown,
  name: string,
  maxBytes = LIMITS.maxMessageBytes,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > maxBytes ||
    [...value].some((c) => c < " " || c === "\u007f")
  )
    throw new Error(`${name} is invalid or exceeds its limit.`);
  return value;
}
export function validateCollection<T>(
  value: unknown,
  name: string,
  item: (item: unknown, index: number) => T,
  max = LIMITS.maxCollectionItems,
): T[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${name} exceeds its item limit.`);
  return value.map(item);
}
