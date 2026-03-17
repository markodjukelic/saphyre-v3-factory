/**
 * When true, entity IDs match the subgraph format (no chainId prefix).
 * Use for single-chain deployment and subgraph comparison.
 * Set to false for multichain (IDs prefixed with chainId).
 */
export const SUBGRAPH_COMPATIBLE_IDS = true;

/** Build entity ID: with prefix (multichain) or without (subgraph-compatible). */
export function makeId(chainId: number, baseId: string): string {
  if (SUBGRAPH_COMPATIBLE_IDS) return baseId;
  return `${chainId}-${baseId}`;
}

/** Bundle entity ID: subgraph uses "1", multichain uses chainId. */
export function bundleId(chainId: number): string {
  if (SUBGRAPH_COMPATIBLE_IDS) return "1";
  return chainId.toString();
}
