import { Pool, Token, Bundle, Factory, BigDecimal, Swap, Tick } from "generated";
import { CHAIN_CONFIGS } from "./utils/chains";
import { ONE_BI, ZERO_BI, ZERO_BD } from './utils/constants';
import { convertTokenToDecimal, loadTransaction, getTransactionGasUsed, getTransactionGasLimit, safeDiv, feeTierToTickSpacing, int256ToSignedBigInt } from './utils/index';
import * as pricing from './utils/pricing';
import * as intervalUpdates from './utils/intervalUpdates';
import { getPoolFeeGrowthEffect, getPoolTickFeeGrowthEffect } from './utils/poolStateEffect';
import { makeId, bundleId, SUBGRAPH_COMPATIBLE_IDS } from './utils/idFormat';
import { FALLBACK_POOL_FEE_GROWTH, FALLBACK_TICK_FEE_VARS } from "./utils/constants";
import { shouldLogPool, shouldLogSwap, shouldLogTransaction, shouldLogTick } from './utils/debugLogAllowlist';
import { SUBGRAPH_EXPECTED } from './utils/debugLogSubgraphExpected';
/** Positive modulo for bigint (subgraph tick math) */
function mod(a: bigint, b: bigint): bigint {
  const r = a % b;
  return r >= 0n ? r : r + b;
}

Pool.Swap.handler(async ({ event, context }) => {
    const {
        factoryAddress,
        stablecoinWrappedNativePoolId,
        stablecoinIsToken0,
        wrappedNativeAddress,
        stablecoinAddresses,
        minimumNativeLocked,
        nativeTokenDetails
    } = CHAIN_CONFIGS[event.chainId];

    const poolId = makeId(event.chainId, event.srcAddress.toLowerCase());
    const poolRO = await context.Pool.get(poolId);
    if (!poolRO) return;

    const factoryIdBase = SUBGRAPH_COMPATIBLE_IDS ? factoryAddress : factoryAddress.toLowerCase();

    const [bundleRO, factoryRO, token0RO, token1RO] = await Promise.all([
        context.Bundle.get(bundleId(event.chainId)),
        context.Factory.get(makeId(event.chainId, factoryIdBase)),
        context.Token.get(poolRO.token0_id),
        context.Token.get(poolRO.token1_id)
    ]);

    if (!bundleRO || !factoryRO || !token0RO || !token1RO) return;

    // Create mutable copies of the entities
    const factory = { ...factoryRO };
    const bundle = { ...bundleRO };
    const token0 = { ...token0RO };
    const token1 = { ...token1RO };
    const pool = { ...poolRO };
    const timestamp = event.block.timestamp;

    // hot fix for bad pricing
    if (pool.id === makeId(event.chainId, '0x9663f2ca0454accad3e094448ea6f77443880454')) {
        return;
    }

    // amounts - 0/1 are token deltas (int256): positive = in, negative = out
    // Use event.params directly (same convention as subgraph)
    const rawAmount0 = event.params.amount0;
    const rawAmount1 = event.params.amount1;
    const signedAmount0 = int256ToSignedBigInt(rawAmount0);
    const signedAmount1 = int256ToSignedBigInt(rawAmount1);
    const amount0 = convertTokenToDecimal(signedAmount0, token0.decimals);
    const amount1 = convertTokenToDecimal(signedAmount1, token1.decimals);

    // need absolute amounts for volume
    const amount0Abs = amount0.lt(ZERO_BD) ? amount0.times(new BigDecimal('-1')) : amount0;
    const amount1Abs = amount1.lt(ZERO_BD) ? amount1.times(new BigDecimal('-1')) : amount1;

    const amount0ETH = amount0Abs.times(token0.derivedETH);
    const amount1ETH = amount1Abs.times(token1.derivedETH);
    const amount0USD = amount0ETH.times(bundle.ethPriceUSD);
    const amount1USD = amount1ETH.times(bundle.ethPriceUSD);

    // get amount that should be tracked only - div 2 because cant count both input and output as volume
    const amountTotalUSDTracked = pricing.getTrackedAmountUSD(
        bundle,
        amount0Abs,
        token0 as Token,
        amount1Abs,
        token1 as Token,
    ).div(new BigDecimal('2'));

    const amountTotalETHTracked = safeDiv(amountTotalUSDTracked, bundle.ethPriceUSD);
    const amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(new BigDecimal('2'));

    const scaler = new BigDecimal(pool.feeTier.toString()).div(new BigDecimal('1000000'));
    const feesETH = amountTotalETHTracked.times(scaler);
    const feesUSD = amountTotalUSDTracked.times(scaler);

    // global updates
    factory.txCount = factory.txCount + ONE_BI;
    factory.swapCount = factory.swapCount + ONE_BI;
    factory.totalVolumeETH = factory.totalVolumeETH.plus(amountTotalETHTracked);
    factory.totalVolumeUSD = factory.totalVolumeUSD.plus(amountTotalUSDTracked);
    factory.untrackedVolumeUSD = factory.untrackedVolumeUSD.plus(amountTotalUSDUntracked);
    factory.totalFeesETH = factory.totalFeesETH.plus(feesETH);
    factory.totalFeesUSD = factory.totalFeesUSD.plus(feesUSD);

    // reset aggregate tvl before individual pool tvl updates
    factory.totalValueLockedETH = factory.totalValueLockedETH.minus(pool.totalValueLockedETH);

    // pool volume
    pool.volumeToken0 = pool.volumeToken0.plus(amount0Abs);
    pool.volumeToken1 = pool.volumeToken1.plus(amount1Abs);
    pool.volumeUSD = pool.volumeUSD.plus(amountTotalUSDTracked);
    pool.untrackedVolumeUSD = pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked);
    pool.feesUSD = pool.feesUSD.plus(feesUSD);
    pool.txCount = pool.txCount + ONE_BI;
    pool.swapCount = pool.swapCount + ONE_BI;

    // Update the pool with the new active liquidity, price, and tick.
    pool.liquidity = event.params.liquidity;
    pool.tick = event.params.tick;
    pool.sqrtPrice = event.params.sqrtPriceX96;
    pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0);
    pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1);

    if (context.log && shouldLogPool(poolId) && (pool.liquidity === 0n || pool.sqrtPrice === 0n || (typeof pool.tick === 'bigint' && pool.tick === 0n))) {
        context.log.info(
            `[Swap] pool_id=${poolId} block=${event.block.number} liquidity=${pool.liquidity} sqrtPrice=${pool.sqrtPrice} tick=${pool.tick}`
        );
    }

    // update token0 data
    token0.volume = token0.volume.plus(amount0Abs);
    token0.totalValueLocked = token0.totalValueLocked.plus(amount0);
    token0.volumeUSD = token0.volumeUSD.plus(amountTotalUSDTracked);
    token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked);
    token0.feesUSD = token0.feesUSD.plus(feesUSD);
    token0.txCount = token0.txCount + ONE_BI;

    // update token1 data
    token1.volume = token1.volume.plus(amount1Abs);
    token1.totalValueLocked = token1.totalValueLocked.plus(amount1);
    token1.volumeUSD = token1.volumeUSD.plus(amountTotalUSDTracked);
    token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked);
    token1.feesUSD = token1.feesUSD.plus(feesUSD);
    token1.txCount = token1.txCount + ONE_BI;

    // updated pool ratess
    const prices = pricing.sqrtPriceX96ToTokenPrices(pool.sqrtPrice, token0, token1, nativeTokenDetails);
    pool.token0Price = prices[0];
    pool.token1Price = prices[1];
    context.Pool.set(pool);

    // update USD pricing
    bundle.ethPriceUSD = await pricing.getNativePriceInUSD(
        context,
        event.chainId,
        stablecoinWrappedNativePoolId,
        stablecoinIsToken0
    );

    context.Bundle.set(bundle);
    
    token0.derivedETH = await pricing.findNativePerToken(
        context,
        token0,
        bundle,
        wrappedNativeAddress,
        stablecoinAddresses,
        minimumNativeLocked,
    );
    token1.derivedETH = await pricing.findNativePerToken(
        context,
        token1,
        bundle,
        wrappedNativeAddress,
        stablecoinAddresses,
        minimumNativeLocked,
    );

    /**
     * Things afffected by new USD rates
     */
    pool.totalValueLockedETH = pool.totalValueLockedToken0
        .times(token0.derivedETH)
        .plus(pool.totalValueLockedToken1.times(token1.derivedETH));
    pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD);

    factory.totalValueLockedETH = factory.totalValueLockedETH.plus(pool.totalValueLockedETH);
    factory.totalValueLockedUSD = factory.totalValueLockedETH.times(bundle.ethPriceUSD);

    token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH).times(bundle.ethPriceUSD);
    token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH).times(bundle.ethPriceUSD);

    // update fee growth (subgraph: read from pool contract after swap)
    try {
        const feeGrowth = await context.effect(getPoolFeeGrowthEffect, {
            poolAddress: event.srcAddress,
            chainId: event.chainId,
            blockNumber: BigInt(event.block.number),
        });
        pool.feeGrowthGlobal0X128 = BigInt(feeGrowth.feeGrowthGlobal0X128);
        pool.feeGrowthGlobal1X128 = BigInt(feeGrowth.feeGrowthGlobal1X128);
    } catch (error) {
        context.log.error(
            `Failed getPoolFeeGrowthEffect in Swap (pool=${poolId}, block=${event.block.number}): ${error instanceof Error ? error.message : String(error)}`
        );
        // Keep existing values; only apply fallback if fields are unset.
        if ((pool as any).feeGrowthGlobal0X128 == null || (pool as any).feeGrowthGlobal1X128 == null) {
            pool.feeGrowthGlobal0X128 = BigInt(FALLBACK_POOL_FEE_GROWTH.feeGrowthGlobal0X128);
            pool.feeGrowthGlobal1X128 = BigInt(FALLBACK_POOL_FEE_GROWTH.feeGrowthGlobal1X128);
        }
    }

    // Subgraph: loadTickUpdateFeeVarsAndSave - only update ticks that already exist; skip (do not create) if null.
    const oldTick = poolRO.tick ?? 0n;
    const newTick = event.params.tick;
    const tickSpacing = feeTierToTickSpacing(pool.feeTier);
    const modulo = mod(newTick, tickSpacing);
    const loadAndUpdateTickFeeVars = async (tickId: string): Promise<void> => {
        const tick = await context.Tick.get(tickId);
        if (!tick) return; // matches subgraph: loadTickUpdateFeeVarsAndSave skips null ticks
        let updated: Tick = { ...tick };
        try {
            const feeVars = await context.effect(getPoolTickFeeGrowthEffect, {
                poolAddress: event.srcAddress,
                chainId: event.chainId,
                tickIdx: Number(tick.tickIdx),
                blockNumber: BigInt(event.block.number),
            });
            updated = {
                ...tick,
                feeGrowthOutside0X128: BigInt(feeVars.feeGrowthOutside0X128),
                feeGrowthOutside1X128: BigInt(feeVars.feeGrowthOutside1X128),
                liquidityGross: BigInt(feeVars.liquidityGross),
                liquidityNet: BigInt(feeVars.liquidityNet),
            };
        } catch (error) {
            context.log.error(
                `Failed getPoolTickFeeGrowthEffect in Swap (pool=${poolId}, tick=${tick.id}, block=${event.block.number}): ${error instanceof Error ? error.message : String(error)}`
            );
            // Keep existing values; only apply fallback if fields are unset.
            if (
                (updated as any).feeGrowthOutside0X128 == null ||
                (updated as any).feeGrowthOutside1X128 == null ||
                (updated as any).liquidityGross == null ||
                (updated as any).liquidityNet == null
            ) {
                updated = {
                    ...updated,
                    feeGrowthOutside0X128: BigInt(FALLBACK_TICK_FEE_VARS.feeGrowthOutside0X128),
                    feeGrowthOutside1X128: BigInt(FALLBACK_TICK_FEE_VARS.feeGrowthOutside1X128),
                    liquidityGross: BigInt(FALLBACK_TICK_FEE_VARS.liquidityGross),
                    liquidityNet: BigInt(FALLBACK_TICK_FEE_VARS.liquidityNet),
                };
            }
        }
        context.Tick.set(updated);
        if (context.log && shouldLogTick(tick.id)) {
            const exp = SUBGRAPH_EXPECTED.Tick[tick.id];
            context.log.info(`[Tick Swap] tickId=${tick.id} liquidityGross=${updated.liquidityGross.toString()} liquidityNet=${updated.liquidityNet.toString()} feeGrowthOutside0=${updated.feeGrowthOutside0X128.toString()} feeGrowthOutside1=${updated.feeGrowthOutside1X128.toString()} subgraph_feeGrowth0=${exp?.feeGrowthOutside0X128 ?? "?"} subgraph_feeGrowth1=${exp?.feeGrowthOutside1X128 ?? "?"}`);
        }
        await intervalUpdates.updateTickDayData(timestamp, updated, context);
    };

    if (modulo === 0n) {
        await loadAndUpdateTickFeeVars(`${poolId}#${newTick}`);
    }
    const numIters = (oldTick - newTick >= 0n ? oldTick - newTick : newTick - oldTick) / tickSpacing;
    if (numIters <= 100n) {
        if (newTick > oldTick) {
            let firstInitialized = oldTick + (tickSpacing - modulo);
            for (let i = firstInitialized; i <= newTick; i += tickSpacing) {
                await loadAndUpdateTickFeeVars(`${poolId}#${i}`);
            }
        } else if (newTick < oldTick) {
            let firstInitialized = oldTick - modulo;
            for (let i = firstInitialized; i >= newTick; i -= tickSpacing) {
                await loadAndUpdateTickFeeVars(`${poolId}#${i}`);
            }
        }
    }

    // create Swap event
    const swapId = `${event.transaction.hash}#${pool.txCount}`;
    const txHash = String(event.transaction.hash);
    const transaction = await loadTransaction(
        txHash,
        event.block.number,
        timestamp,
        event.transaction.gasPrice || ZERO_BI,
        context,
        getTransactionGasUsed(event.transaction),
        getTransactionGasLimit(event.transaction),
        shouldLogTransaction(txHash),
        {
            gasUsed: getTransactionGasUsed(event.transaction),
            gasLimit: getTransactionGasLimit(event.transaction),
            gasPrice: event.transaction.gasPrice ? BigInt(event.transaction.gasPrice.toString()) : undefined,
            blockGasLimit: (event.block as { gasLimit?: bigint })?.gasLimit,
            subgraphExpectedGasUsed: SUBGRAPH_EXPECTED.Transaction[txHash.toLowerCase()]?.gasUsed,
        }
    );

    // So we can follow up events same as v2 (subgraph: if amount0 < amount1 then amount0Out/amount1In, else amount0In/amount1Out)
    let amount0In = ZERO_BD;
    let amount0Out = ZERO_BD;
    let amount1In = ZERO_BD;
    let amount1Out = ZERO_BD;
    if (amount0.lt(amount1)) {
        amount0Out = amount0Abs;
        amount1In = amount1Abs;
    } else if (amount1.lt(amount0)) {
        amount0In = amount0Abs;
        amount1Out = amount1Abs;
    }

    const swap: Swap = {
        // Subgraph: swap.id = transaction.id + '#' + pool.txCount (after pool.txCount incremented)
        id: swapId,
        transaction_id: transaction.id,
        timestamp: transaction.timestamp,
        pool_id: pool.id,
        token0_id: pool.token0_id,
        token1_id: pool.token1_id,
        sender: event.params.sender,
        origin: event.transaction.from?.toLowerCase() || '',
        recipient: event.params.recipient,
        amount0: amount0,
        amount1: amount1,
        amountUSD: amountTotalUSDTracked,
        tick: event.params.tick,
        sqrtPriceX96: event.params.sqrtPriceX96,
        logIndex: BigInt(event.logIndex),
        volumeUSD: amountTotalUSDTracked,
        feesUSD: feesUSD,
        feesETH: feesETH,
        firstTokenUsdPrice: token0.derivedETH.times(bundle.ethPriceUSD),
        secondTokenUsdPrice: token1.derivedETH.times(bundle.ethPriceUSD),
        amount0In,
        amount1In,
        amount0Out,
        amount1Out,
    };

    if (context.log && (shouldLogPool(poolId) || shouldLogSwap(swapId))) {
        const exp = SUBGRAPH_EXPECTED.Swap[swapId.toLowerCase()];
        context.log.info(
            `[Swap] id=${swapId} raw0=${rawAmount0} raw1=${rawAmount1} signed0=${signedAmount0} signed1=${signedAmount1} amount0=${amount0.toString()} amount1=${amount1.toString()} amount0In=${amount0In.toString()} amount1In=${amount1In.toString()} amount0Out=${amount0Out.toString()} amount1Out=${amount1Out.toString()} subgraph_amount0=${exp?.amount0 ?? "?"} subgraph_amount1=${exp?.amount1 ?? "?"} subgraph_amount0In=${exp?.amount0In ?? "?"} subgraph_amount1Out=${exp?.amount1Out ?? "?"}`
        );
    }

    // interval data
    const uniswapDayData = { ...await intervalUpdates.updateUniswapDayData(timestamp, event.chainId, factory, context) };
    const poolDayData = { ...await intervalUpdates.updatePoolDayData(timestamp, pool, context) };
    const poolHourData = { ...await intervalUpdates.updatePoolHourData(timestamp, pool, context) };
    const token0DayData = { ...await intervalUpdates.updateTokenDayData(timestamp, token0, bundle, context) };
    const token1DayData = { ...await intervalUpdates.updateTokenDayData(timestamp, token1, bundle, context) };
    const token0HourData = { ...await intervalUpdates.updateTokenHourData(timestamp, token0, bundle, context) };
    const token1HourData = { ...await intervalUpdates.updateTokenHourData(timestamp, token1, bundle, context) };

    // update volume metrics
    uniswapDayData.volumeETH = uniswapDayData.volumeETH.plus(amountTotalETHTracked);
    uniswapDayData.volumeUSD = uniswapDayData.volumeUSD.plus(amountTotalUSDTracked);
    uniswapDayData.feesUSD = uniswapDayData.feesUSD.plus(feesUSD);

    poolDayData.volumeUSD = poolDayData.volumeUSD.plus(amountTotalUSDTracked);
    poolDayData.volumeToken0 = poolDayData.volumeToken0!.plus(amount0Abs);
    poolDayData.volumeToken1 = poolDayData.volumeToken1!.plus(amount1Abs);
    poolDayData.feesUSD = poolDayData.feesUSD!.plus(feesUSD);

    poolHourData.volumeUSD = poolHourData.volumeUSD!.plus(amountTotalUSDTracked);
    poolHourData.volumeToken0 = poolHourData.volumeToken0!.plus(amount0Abs);
    poolHourData.volumeToken1 = poolHourData.volumeToken1!.plus(amount1Abs);
    poolHourData.feesUSD = poolHourData.feesUSD!.plus(feesUSD);

    token0DayData.volume = token0DayData.volume.plus(amount0Abs);
    token0DayData.volumeUSD = token0DayData.volumeUSD.plus(amountTotalUSDTracked);
    token0DayData.untrackedVolumeUSD = token0DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked);
    token0DayData.feesUSD = token0DayData.feesUSD.plus(feesUSD);

    token0HourData.volume = token0HourData.volume.plus(amount0Abs);
    token0HourData.volumeUSD = token0HourData.volumeUSD.plus(amountTotalUSDTracked);
    token0HourData.untrackedVolumeUSD = token0HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked);
    token0HourData.feesUSD = token0HourData.feesUSD.plus(feesUSD);

    token1DayData.volume = token1DayData.volume.plus(amount1Abs);
    token1DayData.volumeUSD = token1DayData.volumeUSD.plus(amountTotalUSDTracked);
    token1DayData.untrackedVolumeUSD = token1DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked);
    token1DayData.feesUSD = token1DayData.feesUSD.plus(feesUSD);

    token1HourData.volume = token1HourData.volume.plus(amount1Abs);
    token1HourData.volumeUSD = token1HourData.volumeUSD.plus(amountTotalUSDTracked);
    token1HourData.untrackedVolumeUSD = token1HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked);
    token1HourData.feesUSD = token1HourData.feesUSD.plus(feesUSD);

    context.Swap.set(swap);
    context.TokenDayData.set(token0DayData);
    context.TokenDayData.set(token1DayData);
    context.UniswapDayData.set(uniswapDayData);
    context.PoolDayData.set(poolDayData);
    context.PoolHourData.set(poolHourData);
    context.TokenHourData.set(token0HourData);
    context.TokenHourData.set(token1HourData);
    context.Factory.set(factory);
    context.Pool.set(pool);
    context.Token.set(token0);
    context.Token.set(token1);
});
