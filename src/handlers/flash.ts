import { Pool } from "generated";
import { getPoolFeeGrowthEffect } from "./utils/poolStateEffect";
import { makeId } from "./utils/idFormat";

/**
 * Subgraph handleFlash: reads feeGrowthGlobal0X128 and feeGrowthGlobal1X128 from pool contract,
 * updates pool entity and saves.
 */
Pool.Flash.handler(async ({ event, context }) => {
  const poolId = makeId(event.chainId, event.srcAddress.toLowerCase());
  const pool = await context.Pool.get(poolId);
  if (!pool) return;

  const updatedPool = { ...pool };
  try {
    const feeGrowth = await context.effect(getPoolFeeGrowthEffect, {
      poolAddress: event.srcAddress,
      chainId: event.chainId,
      blockNumber: BigInt(event.block.number),
    });
    updatedPool.feeGrowthGlobal0X128 = BigInt(feeGrowth.feeGrowthGlobal0X128);
    updatedPool.feeGrowthGlobal1X128 = BigInt(feeGrowth.feeGrowthGlobal1X128);
  } catch (error) {
    context.log.error(
      `Failed getPoolFeeGrowthEffect in Flash (pool=${poolId}, block=${event.block.number}): ${error instanceof Error ? error.message : String(error)}`
    );
  }

  context.Pool.set(updatedPool);
});
