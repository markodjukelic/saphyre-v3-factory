import { BigDecimal } from "generated";
import { Tick } from "generated";
import { ZERO_BD, ONE_BD, ZERO_BI } from "./constants";
import { _fastExponentiation, safeDiv } from "./index";

/**
 * Create a minimal Tick entity. Used by Mint when creating new ticks, and by Swap
 * when crossing a tick that doesn't exist yet (to match subgraph behavior of
 * having ticks with liquidityNet from contract when crossed in Swap).
 */
export function createTick(
  tickId: string,
  tickIdx: bigint,
  poolId: string,
  timestamp: number,
  blockNumber: number,
  feeVars?: {
    liquidityGross: string;
    liquidityNet: string;
    feeGrowthOutside0X128: string;
    feeGrowthOutside1X128: string;
  }
): Tick {
  const Price0 = _fastExponentiation(new BigDecimal("1.0001"), tickIdx);
  return {
    id: tickId,
    tickIdx: tickIdx,
    pool_id: poolId,
    poolAddress: poolId,
    createdAtTimestamp: BigInt(timestamp),
    createdAtBlockNumber: BigInt(blockNumber),
    liquidityGross: feeVars ? BigInt(feeVars.liquidityGross) : ZERO_BI,
    liquidityNet: feeVars ? BigInt(feeVars.liquidityNet) : ZERO_BI,
    price0: Price0,
    price1: safeDiv(ONE_BD, Price0),
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    collectedFeesUSD: ZERO_BD,
    liquidityProviderCount: ZERO_BI,
    feeGrowthOutside0X128: feeVars ? BigInt(feeVars.feeGrowthOutside0X128) : ZERO_BI,
    feeGrowthOutside1X128: feeVars ? BigInt(feeVars.feeGrowthOutside1X128) : ZERO_BI,
  };
}
