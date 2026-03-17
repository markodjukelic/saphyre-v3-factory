/**
 * Debug logging allowlist - one ID per entity from the comparison diff summary.
 * When an entity matches, we log relevant field calculations to trace discrepancies.
 * Pool ID format: lowercase address (SUBGRAPH_COMPATIBLE_IDS) or "chainId-address".
 */
const DEBUG_LOG_TOKEN_IDS = new Set<string>([
  "0x059a6b0ba116c63191182a0956cf697d0d2213ec",
]);

const DEBUG_LOG_POOL_IDS = new Set<string>([
  "0x01430caba3b858561bb85e8ed1e4389740f7ef17",
]);

const DEBUG_LOG_BURN_IDS = new Set<string>([
  "0x00000204e493afc4a52e7c3dc73277c2976b6ff0902238307d560f5898fa5779#846212",
]);

const DEBUG_LOG_SWAP_IDS = new Set<string>([
  "0x00000204e493afc4a52e7c3dc73277c2976b6ff0902238307d560f5898fa5779#846206",
]);

const DEBUG_LOG_TRANSACTION_IDS = new Set<string>([
  "0x00000090ed37a80465ae911a34fdb39fcbbd1c2506c3cbd9521962698975c1e0",
]);

const DEBUG_LOG_TICK_IDS = new Set<string>([
  "0x04f538d9065146e4fac4882f1ccf6d2786f8a9a4#-161200",
]);

export function shouldLogPool(poolId: string): boolean {
  if (DEBUG_LOG_POOL_IDS.size === 0) return false;
  const normalized = poolId.toLowerCase();
  return (
    DEBUG_LOG_POOL_IDS.has(poolId) ||
    DEBUG_LOG_POOL_IDS.has(normalized) ||
    DEBUG_LOG_POOL_IDS.has(poolId.split("-")[1]?.toLowerCase() ?? "")
  );
}

export function shouldLogToken(tokenId: string): boolean {
  if (DEBUG_LOG_TOKEN_IDS.size === 0) return false;
  const normalized = tokenId.toLowerCase();
  return DEBUG_LOG_TOKEN_IDS.has(tokenId) || DEBUG_LOG_TOKEN_IDS.has(normalized);
}

export function shouldLogBurn(burnId: string): boolean {
  return DEBUG_LOG_BURN_IDS.has(burnId) || DEBUG_LOG_BURN_IDS.has(burnId.toLowerCase());
}

export function shouldLogSwap(swapId: string): boolean {
  return DEBUG_LOG_SWAP_IDS.has(swapId) || DEBUG_LOG_SWAP_IDS.has(swapId.toLowerCase());
}

export function shouldLogTransaction(txId: string): boolean {
  const normalized = txId.toLowerCase();
  return (
    DEBUG_LOG_TRANSACTION_IDS.has(txId) || DEBUG_LOG_TRANSACTION_IDS.has(normalized)
  );
}

export function shouldLogTick(tickId: string): boolean {
  return DEBUG_LOG_TICK_IDS.has(tickId);
}
