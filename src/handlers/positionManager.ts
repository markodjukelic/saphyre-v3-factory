import { NonfungiblePositionManager } from "generated";
import type { Position, PositionSnapshot } from "generated";
import { CHAIN_CONFIGS } from "./utils/chains";
import { ADDRESS_ZERO, ZERO_BD, ZERO_BI } from "./utils/constants";
import { convertTokenToDecimal, loadTransaction, getTransactionGasUsed, getTransactionGasLimit } from "./utils/index";
import { makeId } from "./utils/idFormat";
import { shouldLogPool } from "./utils/debugLogAllowlist";

const POOLS_TO_SKIP = ["0x8fe8d9bb8eeba3ed688069c3d6b556c9ca258248"];

function computeFeeGrowthInside(pool: any, tickLower: any, tickUpper: any): {
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
} {
  const tickCurrent: bigint = pool.tick ?? 0n;

  const feeGrowthGlobal0X128: bigint = pool.feeGrowthGlobal0X128;
  const feeGrowthGlobal1X128: bigint = pool.feeGrowthGlobal1X128;

  // Uniswap v3 getFeeGrowthInside formula, derived from:
  // - pool.feeGrowthGlobal*
  // - tick.feeGrowthOutside*
  const feeGrowthBelow0 = tickCurrent >= tickLower.tickIdx
    ? tickLower.feeGrowthOutside0X128
    : feeGrowthGlobal0X128 - tickLower.feeGrowthOutside0X128;
  const feeGrowthAbove0 = tickCurrent < tickUpper.tickIdx
    ? tickUpper.feeGrowthOutside0X128
    : feeGrowthGlobal0X128 - tickUpper.feeGrowthOutside0X128;
  const feeGrowthInside0 = feeGrowthGlobal0X128 - feeGrowthBelow0 - feeGrowthAbove0;

  const feeGrowthBelow1 = tickCurrent >= tickLower.tickIdx
    ? tickLower.feeGrowthOutside1X128
    : feeGrowthGlobal1X128 - tickLower.feeGrowthOutside1X128;
  const feeGrowthAbove1 = tickCurrent < tickUpper.tickIdx
    ? tickUpper.feeGrowthOutside1X128
    : feeGrowthGlobal1X128 - tickUpper.feeGrowthOutside1X128;
  const feeGrowthInside1 = feeGrowthGlobal1X128 - feeGrowthBelow1 - feeGrowthAbove1;

  return { feeGrowthInside0LastX128: feeGrowthInside0, feeGrowthInside1LastX128: feeGrowthInside1 };
}

async function getOrCreatePositionFromPoolMintCache(
  event: {
    chainId: number;
    block: { timestamp: number; number: number };
    transaction?: { hash: string; gasPrice?: bigint };
    logIndex?: number;
  },
  tokenId: bigint,
  context: any,
  owner: string
): Promise<Position | undefined> {
  const positionId = makeId(event.chainId, tokenId.toString());
  const existing = await context.Position.get(positionId);
  if (existing) return existing;

  const tx = event.transaction;
  if (!tx?.hash) return undefined;
  const txHashLower = tx.hash.toLowerCase();
  const targetLogIndex = BigInt(event.logIndex ?? 0);

  // Find the closest prior Pool.Mint within the same tx (by logIndex).
  const cacheEntries = await context.PoolMintEventCache.getWhere({
    txHash: { _eq: txHashLower },
  });

  let best: any | null = null;
  for (const entry of cacheEntries) {
    const li = BigInt(entry.logIndex);
    if (li < targetLogIndex && (best === null || li > BigInt(best.logIndex))) {
      best = entry;
    }
  }
  if (!best) return undefined;

  const pool = await context.Pool.get(best.poolId);
  if (!pool) return undefined;

  const poolIdLower = String(pool.id).toLowerCase();
  if (POOLS_TO_SKIP.includes(poolIdLower)) return undefined;

  const tickLowerId = `${pool.id}#${BigInt(best.tickLower).toString()}`;
  const tickUpperId = `${pool.id}#${BigInt(best.tickUpper).toString()}`;

  const [tickLower, tickUpper] = await Promise.all([
    context.Tick.get(tickLowerId),
    context.Tick.get(tickUpperId),
  ]);
  if (!tickLower || !tickUpper) return undefined;

  const [token0, token1] = await Promise.all([
    context.Token.get(pool.token0_id),
    context.Token.get(pool.token1_id),
  ]);
  if (!token0 || !token1) return undefined;

  const transaction = await loadTransaction(
    tx.hash,
    event.block.number,
    event.block.timestamp,
    tx.gasPrice ?? 0n,
    context,
    getTransactionGasUsed(tx as any),
    getTransactionGasLimit(tx as any),
    shouldLogPool(pool.id)
  );

  const { feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = computeFeeGrowthInside(pool, tickLower, tickUpper);

  const newPosition: Position = {
    id: positionId,
    owner: owner.toLowerCase(),
    pool_id: pool.id,
    token0_id: pool.token0_id,
    token1_id: pool.token1_id,
    tickLower_id: tickLowerId,
    tickUpper_id: tickUpperId,
    liquidity: ZERO_BI,
    depositedToken0: ZERO_BD,
    depositedToken1: ZERO_BD,
    withdrawnToken0: ZERO_BD,
    withdrawnToken1: ZERO_BD,
    collectedToken0: ZERO_BD,
    collectedToken1: ZERO_BD,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    transaction_id: transaction.id,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };

  context.Position.set(newPosition);

  // Prevent the cache from growing without bound.
  // Safe because each newly minted position should be created at most once.
  try {
    context.PoolMintEventCache.deleteUnsafe(best.id);
  } catch {
    // ignore if delete is unsupported in this environment
  }

  return newPosition;
}

async function savePositionSnapshot(
  position: Position,
  event: { chainId: number; block: { number: number; timestamp: number }; transaction?: { hash: string; gasPrice?: bigint } },
  context: any
): Promise<void> {
  const snapshotId = `${position.id}#${event.block.number}`;
  const txHash = event.transaction?.hash;
  if (!txHash) return;
  const transaction = await loadTransaction(
    txHash,
    event.block.number,
    event.block.timestamp,
    event.transaction?.gasPrice ?? 0n,
    context,
    getTransactionGasUsed(event.transaction),
    getTransactionGasLimit(event.transaction),
    shouldLogPool(position.pool_id)
  );
  const snapshot: PositionSnapshot = {
    id: snapshotId,
    owner: position.owner,
    pool_id: position.pool_id,
    position_id: position.id,
    blockNumber: BigInt(event.block.number),
    timestamp: BigInt(event.block.timestamp),
    liquidity: position.liquidity,
    depositedToken0: position.depositedToken0,
    depositedToken1: position.depositedToken1,
    withdrawnToken0: position.withdrawnToken0,
    withdrawnToken1: position.withdrawnToken1,
    collectedFeesToken0: position.collectedFeesToken0,
    collectedFeesToken1: position.collectedFeesToken1,
    transaction_id: transaction.id,
    feeGrowthInside0LastX128: position.feeGrowthInside0LastX128,
    feeGrowthInside1LastX128: position.feeGrowthInside1LastX128,
  };
  context.PositionSnapshot.set(snapshot);
}

NonfungiblePositionManager.IncreaseLiquidity.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  const tokenId = event.params.tokenId as bigint;
  const positionId = makeId(event.chainId, tokenId.toString());

  let position = await context.Position.get(positionId);
  if (!position) {
    // Matches subgraph: initial owner is ADDRESS_ZERO until Transfer(from=0) updates it.
    position = await getOrCreatePositionFromPoolMintCache(event as any, tokenId, context, ADDRESS_ZERO);
    if (!position) return;
  }

  if (POOLS_TO_SKIP.includes(String(position.pool_id).toLowerCase())) return;

  const [pool, tickLower, tickUpper, token0, token1] = await Promise.all([
    context.Pool.get(position.pool_id),
    context.Tick.get(position.tickLower_id),
    context.Tick.get(position.tickUpper_id),
    context.Token.get(position.token0_id),
    context.Token.get(position.token1_id),
  ]);
  if (!pool || !tickLower || !tickUpper || !token0 || !token1) return;

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  const { feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = computeFeeGrowthInside(pool, tickLower, tickUpper);

  const updated: Position = {
    ...position,
    liquidity: position.liquidity + event.params.liquidity,
    depositedToken0: position.depositedToken0.plus(amount0),
    depositedToken1: position.depositedToken1.plus(amount1),
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };

  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});

NonfungiblePositionManager.DecreaseLiquidity.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  const tokenId = event.params.tokenId as bigint;
  const positionId = makeId(event.chainId, tokenId.toString());

  let position = await context.Position.get(positionId);
  if (!position) {
    position = await getOrCreatePositionFromPoolMintCache(event as any, tokenId, context, ADDRESS_ZERO);
    if (!position) return;
  }

  if (POOLS_TO_SKIP.includes(String(position.pool_id).toLowerCase())) return;

  const [pool, tickLower, tickUpper, token0, token1] = await Promise.all([
    context.Pool.get(position.pool_id),
    context.Tick.get(position.tickLower_id),
    context.Tick.get(position.tickUpper_id),
    context.Token.get(position.token0_id),
    context.Token.get(position.token1_id),
  ]);
  if (!pool || !tickLower || !tickUpper || !token0 || !token1) return;

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  const { feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = computeFeeGrowthInside(pool, tickLower, tickUpper);

  const updated: Position = {
    ...position,
    liquidity: position.liquidity - event.params.liquidity,
    withdrawnToken0: position.withdrawnToken0.plus(amount0),
    withdrawnToken1: position.withdrawnToken1.plus(amount1),
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };

  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});

NonfungiblePositionManager.Collect.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  const tokenId = event.params.tokenId as bigint;
  const positionId = makeId(event.chainId, tokenId.toString());

  let position = await context.Position.get(positionId);
  if (!position) {
    position = await getOrCreatePositionFromPoolMintCache(event as any, tokenId, context, ADDRESS_ZERO);
    if (!position) return;
  }

  if (POOLS_TO_SKIP.includes(String(position.pool_id).toLowerCase())) return;

  const [pool, tickLower, tickUpper, token0, token1] = await Promise.all([
    context.Pool.get(position.pool_id),
    context.Tick.get(position.tickLower_id),
    context.Tick.get(position.tickUpper_id),
    context.Token.get(position.token0_id),
    context.Token.get(position.token1_id),
  ]);
  if (!pool || !tickLower || !tickUpper || !token0 || !token1) return;

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  const collectedToken0 = position.collectedToken0.plus(amount0);
  const collectedToken1 = position.collectedToken1.plus(amount1);
  const collectedFeesToken0 = collectedToken0.minus(position.withdrawnToken0);
  const collectedFeesToken1 = collectedToken1.minus(position.withdrawnToken1);

  const { feeGrowthInside0LastX128, feeGrowthInside1LastX128 } = computeFeeGrowthInside(pool, tickLower, tickUpper);

  const updated: Position = {
    ...position,
    collectedToken0,
    collectedToken1,
    collectedFeesToken0,
    collectedFeesToken1,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128,
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };

  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});

NonfungiblePositionManager.Transfer.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  const owner = event.params.to?.toLowerCase() ?? ADDRESS_ZERO;
  const from = event.params.from?.toLowerCase() ?? ADDRESS_ZERO;

  const tokenId = event.params.tokenId as bigint;
  const positionId = makeId(event.chainId, tokenId.toString());

  let position = await context.Position.get(positionId);
  if (position) {
    const updated: Position = {
      ...position,
      owner,
      lastUpdatedBlockNumber: BigInt(event.block.number),
      lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
    };
    context.Position.set(updated);
    await savePositionSnapshot(updated, event, context);
    return;
  }

  // Only create positions when minting (from == 0x0).
  if (from !== ADDRESS_ZERO) return;

  position = await getOrCreatePositionFromPoolMintCache(event as any, tokenId, context, owner);
  if (!position) return;

  const updated: Position = {
    ...position,
    owner,
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };
  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});
