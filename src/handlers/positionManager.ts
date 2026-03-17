import { NonfungiblePositionManager } from "generated";
import type { Position, PositionSnapshot } from "generated";
import { CHAIN_CONFIGS } from "./utils/chains";
import { ADDRESS_ZERO, ZERO_BD, ZERO_BI } from "./utils/constants";
import { convertTokenToDecimal, loadTransaction, getTransactionGasUsed, getTransactionGasLimit } from "./utils/index";
import { getPositionDataEffect } from "./utils/positionDataEffect";
import { makeId } from "./utils/idFormat";
import { shouldLogPool } from "./utils/debugLogAllowlist";

const POOLS_TO_SKIP = ["0x8fe8d9bb8eeba3ed688069c3d6b556c9ca258248"];

export type PositionDataFromEffect = {
  poolAddress: string;
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  feeGrowthInside0LastX128: string;
  feeGrowthInside1LastX128: string;
};

async function getOrCreatePosition(
  event: { chainId: number; srcAddress: string; block: { timestamp: number; number: number }; transaction?: { hash: string; gasPrice?: bigint }; logIndex?: number },
  tokenId: bigint,
  context: any,
  positionData: PositionDataFromEffect,
  owner: string
): Promise<Position | null> {
  const chainId = event.chainId;
  const positionId = makeId(chainId, tokenId.toString());
  const existing = await context.Position.get(positionId);
  if (existing) return existing;

  const factoryAddress = CHAIN_CONFIGS[chainId]?.factoryAddress;
  if (!factoryAddress) return null;

  const poolId = makeId(chainId, positionData.poolAddress.toLowerCase());
  const token0Id = makeId(chainId, positionData.token0.toLowerCase());
  const token1Id = makeId(chainId, positionData.token1.toLowerCase());
  const tickLowerId = `${poolId}#${positionData.tickLower}`;
  const tickUpperId = `${poolId}#${positionData.tickUpper}`;

  // TODO: Ensure Tick entities exist for tickLowerId and tickUpperId (subgraph creates them in Mint handler).
  // If Ticks are missing, we may need to create minimal Tick entities or skip position creation.
  const tickLowerExists = await context.Tick.get(tickLowerId);
  const tickUpperExists = await context.Tick.get(tickUpperId);
  if (!tickLowerExists || !tickUpperExists) {
    // Skip creating position until Ticks exist (e.g. after first Mint on this position)
    return null;
  }

  const txHash = event.transaction?.hash;
  if (!txHash) return null;
  const transaction = await loadTransaction(
    txHash,
    event.block.number,
    event.block.timestamp,
    event.transaction?.gasPrice ?? 0n,
    context,
    getTransactionGasUsed(event.transaction),
    getTransactionGasLimit(event.transaction),
    shouldLogPool(poolId)
  );

  const newPosition: Position = {
    id: positionId,
    owner: owner.toLowerCase(),
    pool_id: poolId,
    token0_id: token0Id,
    token1_id: token1Id,
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
    feeGrowthInside0LastX128: BigInt(positionData.feeGrowthInside0LastX128),
    feeGrowthInside1LastX128: BigInt(positionData.feeGrowthInside1LastX128),
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };
  context.Position.set(newPosition);
  return newPosition;
}

async function savePositionSnapshot(
  position: position,
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

  let positionData: PositionDataFromEffect;
  try {
    positionData = (await context.effect(getPositionDataEffect, {
      npmAddress: event.srcAddress,
      tokenId: event.params.tokenId.toString(),
      chainId: event.chainId,
      factoryAddress,
      blockNumber: event.block.number,
    })) as PositionDataFromEffect;
  } catch {
    // Position not fetchable (e.g. mint+burn same block). Skip like subgraph getPosition == null.
    return;
  }
  if (!positionData.poolAddress) return;
  if (POOLS_TO_SKIP.includes(positionData.poolAddress.toLowerCase())) return;

  // Owner not known from this event; use ADDRESS_ZERO and rely on Transfer to set it (matches subgraph)
  const position = await getOrCreatePosition(event, event.params.tokenId, context, positionData, ADDRESS_ZERO);
  if (!position) return;

  const token0 = await context.Token.get(makeId(event.chainId, positionData.token0.toLowerCase()));
  const token1 = await context.Token.get(makeId(event.chainId, positionData.token1.toLowerCase()));
  if (!token0 || !token1) return;

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  const updated: Position = {
    ...position,
    liquidity: position.liquidity + event.params.liquidity,
    depositedToken0: position.depositedToken0.plus(amount0),
    depositedToken1: position.depositedToken1.plus(amount1),
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };
  // TODO: updateFeeVars - re-call effect to get latest feeGrowthInside* and set on updated
  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});

NonfungiblePositionManager.DecreaseLiquidity.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  let positionData: PositionDataFromEffect;
  try {
    positionData = (await context.effect(getPositionDataEffect, {
      npmAddress: event.srcAddress,
      tokenId: event.params.tokenId.toString(),
      chainId: event.chainId,
      factoryAddress,
      blockNumber: event.block.number,
    })) as PositionDataFromEffect;
  } catch {
    // Position not fetchable (e.g. mint+burn same block). Skip like subgraph getPosition == null.
    return;
  }
  if (!positionData.poolAddress) return;
  if (POOLS_TO_SKIP.includes(positionData.poolAddress.toLowerCase())) return;

  const position = await getOrCreatePosition(event, event.params.tokenId, context, positionData, ADDRESS_ZERO);
  if (!position) return;

  const token0 = await context.Token.get(makeId(event.chainId, positionData.token0.toLowerCase()));
  const token1 = await context.Token.get(makeId(event.chainId, positionData.token1.toLowerCase()));
  if (!token0 || !token1) return;

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  const updated: Position = {
    ...position,
    liquidity: position.liquidity - event.params.liquidity,
    withdrawnToken0: position.withdrawnToken0.plus(amount0),
    withdrawnToken1: position.withdrawnToken1.plus(amount1),
    feeGrowthInside0LastX128: BigInt(positionData.feeGrowthInside0LastX128),
    feeGrowthInside1LastX128: BigInt(positionData.feeGrowthInside1LastX128),
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };
  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});

NonfungiblePositionManager.Collect.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  let positionData: PositionDataFromEffect;
  try {
    positionData = (await context.effect(getPositionDataEffect, {
      npmAddress: event.srcAddress,
      tokenId: event.params.tokenId.toString(),
      chainId: event.chainId,
      factoryAddress,
      blockNumber: event.block.number,
    })) as PositionDataFromEffect;
  } catch {
    // Position not fetchable (e.g. mint+burn same block). Skip like subgraph getPosition == null.
    return;
  }
  if (!positionData.poolAddress) return;
  if (POOLS_TO_SKIP.includes(positionData.poolAddress.toLowerCase())) return;

  const position = await getOrCreatePosition(event, event.params.tokenId, context, positionData, ADDRESS_ZERO);
  if (!position) return;

  const token0 = await context.Token.get(makeId(event.chainId, positionData.token0.toLowerCase()));
  const token1 = await context.Token.get(makeId(event.chainId, positionData.token1.toLowerCase()));
  if (!token0 || !token1) return;

  const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
  const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

  const collectedToken0 = position.collectedToken0.plus(amount0);
  const collectedToken1 = position.collectedToken1.plus(amount1);
  const collectedFeesToken0 = collectedToken0.minus(position.withdrawnToken0);
  const collectedFeesToken1 = collectedToken1.minus(position.withdrawnToken1);

  const updated: Position = {
    ...position,
    collectedToken0,
    collectedToken1,
    collectedFeesToken0,
    collectedFeesToken1,
    feeGrowthInside0LastX128: BigInt(positionData.feeGrowthInside0LastX128),
    feeGrowthInside1LastX128: BigInt(positionData.feeGrowthInside1LastX128),
    lastUpdatedBlockNumber: BigInt(event.block.number),
    lastUpdatedBlockTimestamp: BigInt(event.block.timestamp),
  };
  context.Position.set(updated);
  await savePositionSnapshot(updated, event, context);
});

NonfungiblePositionManager.Transfer.handler(async ({ event, context }) => {
  const { factoryAddress } = CHAIN_CONFIGS[event.chainId] ?? {};
  if (!factoryAddress) return;

  let positionData: PositionDataFromEffect;
  try {
    positionData = (await context.effect(getPositionDataEffect, {
      npmAddress: event.srcAddress,
      tokenId: event.params.tokenId.toString(),
      chainId: event.chainId,
      factoryAddress,
      blockNumber: event.block.number,
    })) as PositionDataFromEffect;
  } catch {
    // Position not fetchable (e.g. token burned — contract reverts "Invalid token ID"). Skip like subgraph.
    return;
  }
  if (!positionData.poolAddress) return;

  const owner = event.params.to?.toLowerCase() ?? ADDRESS_ZERO;
  const position = await getOrCreatePosition(event, event.params.tokenId, context, positionData, owner);
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
