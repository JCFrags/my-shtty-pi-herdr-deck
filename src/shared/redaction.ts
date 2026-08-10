const secret = /(api[_-]?key|token|password|secret|authorization)/i;
export function redactRecord(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactRecord);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        secret.test(key) ? "<redacted>" : redactRecord(item),
      ]),
    );
  return value;
}
