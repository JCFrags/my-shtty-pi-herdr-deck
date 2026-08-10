export const LIMITS = {
  maxLineBytes: 1_048_576,
  maxMessageBytes: 262_144,
  maxCollectionItems: 4_096,
  maxConnections: 64,
  maxActiveAgents: 32,
  maxActivePerParent: 16,
  maxQueuedTasks: 1_000,
  maxTasksPerDelegate: 32,
  maxDelegationDepth: 4,
  maxArtifactBytes: 64 * 1024 * 1024,
} as const;
export function boundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  return value as number;
}
