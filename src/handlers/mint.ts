import { Pool, Token, Bundle, Factory, Tick, BigDecimal } from "generated";
import { convertTokenToDecimal, loadTransaction, getTransactionGasUsed, getTransactionGasLimit } from './utils/index';
import { createTick } from "./utils/tickHelpers";
import { ONE_BI, ZERO_BI, ONE_BD, ZERO_BD } from './utils/constants';
import { CHAIN_CONFIGS } from "./utils/chains";
import * as intervalUpdates from './utils/intervalUpdates';
import { getPoolTickFeeGrowthEffect } from './utils/poolStateEffect';
import { makeId, bundleId, SUBGRAPH_COMPATIBLE_IDS } from './utils/idFormat';
import { shouldLogPool, shouldLogToken, shouldLogTransaction } from './utils/debugLogAllowlist';
import { SUBGRAPH_EXPECTED } from './utils/debugLogSubgraphExpected';


Pool.Mint.handler(async ({ event, context }) => {
    const { factoryAddress } = CHAIN_CONFIGS[event.chainId];
    const factoryIdBase = SUBGRAPH_COMPATIBLE_IDS ? factoryAddress : factoryAddress.toLowerCase();
    const poolId = makeId(event.chainId, event.srcAddress.toLowerCase());
    const poolRO = await context.Pool.get(poolId);
    if (!poolRO) return;

    // tick entities
    const factoryId = makeId(event.chainId, factoryIdBase);
    const lowerTickId = `${poolId}#${event.params.tickLower}`;
    const upperTickId = `${poolId}#${event.params.tickUpper}`;

    let [bundleRO, factoryRO, token0RO, token1RO, lowerTickRO, upperTickRO] = await Promise.all([
        context.Bundle.get(bundleId(event.chainId)),
        context.Factory.get(factoryId),
        context.Token.get(poolRO.token0_id),
        context.Token.get(poolRO.token1_id),
        context.Tick.get(lowerTickId),
        context.Tick.get(upperTickId),
    ]);

    if (!bundleRO || !factoryRO || !token0RO || !token1RO) return;
    // Note: ticks (lowerTickRO, upperTickRO) are optional - they will be created if they don't exist

    // Create mutable copies of the entities
    const bundle = { ...bundleRO };
    const factory = { ...factoryRO };
    const token0 = { ...token0RO };
    const token1 = { ...token1RO };
    const pool = { ...poolRO };

    const timestamp = event.block.timestamp;

    const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
    const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

    const amountUSD = amount0
        .times(token0.derivedETH.times(bundle.ethPriceUSD))
        .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)));

    // reset tvl aggregates until new amounts calculated
    factory.totalValueLockedETH = factory.totalValueLockedETH.minus(pool.totalValueLockedETH);

    // update globals
    factory.txCount = factory.txCount + ONE_BI;
    factory.mintCount = factory.mintCount + ONE_BI;

    // update token0 data
    token0.txCount = token0.txCount + ONE_BI;
    token0.totalValueLocked = token0.totalValueLocked.plus(amount0);
    token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH.times(bundle.ethPriceUSD));

    // update token1 data
    token1.txCount = token1.txCount + ONE_BI;
    token1.totalValueLocked = token1.totalValueLocked.plus(amount1);
    token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH.times(bundle.ethPriceUSD));

    // pool data
    pool.txCount = pool.txCount + ONE_BI;
    pool.mintCount = pool.mintCount + ONE_BI;

    // Pools liquidity tracks the currently active liquidity given pools current tick.
    // We only want to update it on mint if the new position includes the current tick.
    if (
        typeof (pool.tick) === 'bigint' &&
        event.params.tickLower <= pool.tick &&
        event.params.tickUpper > pool.tick
    ) {
        pool.liquidity = pool.liquidity + event.params.amount;
    }

    pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0);
    pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1);
    pool.totalValueLockedETH = pool.totalValueLockedToken0
        .times(token0.derivedETH)
        .plus(pool.totalValueLockedToken1.times(token1.derivedETH));
    pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD);

    // reset aggregates with new amounts
    factory.totalValueLockedETH = factory.totalValueLockedETH.plus(pool.totalValueLockedETH);
    factory.totalValueLockedUSD = factory.totalValueLockedETH.times(bundle.ethPriceUSD);

    if (context.log && shouldLogPool(pool.id)) {
        context.log.info(
            `[Mint] pool_id=${pool.id} block=${event.block.number} amount0=${amount0.toString()} amount1=${amount1.toString()} pool_tvl0=${pool.totalValueLockedToken0.toString()} pool_tvl1=${pool.totalValueLockedToken1.toString()}`
        );
    }

    const txHash = String(event.transaction.hash);
    const transaction = await loadTransaction(
        txHash,
        event.block.number,
        event.block.timestamp,
        event.transaction.gasPrice || ZERO_BI,
        context,
        getTransactionGasUsed(event.transaction),
        getTransactionGasLimit(event.transaction),
        shouldLogPool(pool.id) || shouldLogTransaction(txHash),
        {
            gasUsed: getTransactionGasUsed(event.transaction),
            gasLimit: getTransactionGasLimit(event.transaction),
            gasPrice: event.transaction.gasPrice ? BigInt(event.transaction.gasPrice.toString()) : undefined,
            blockGasLimit: (event.block as { gasLimit?: bigint })?.gasLimit,
            subgraphExpectedGasUsed: SUBGRAPH_EXPECTED.Transaction[txHash.toLowerCase()]?.gasUsed,
        }
    );

    // Subgraph: mint.id = transaction.id + '#' + pool.txCount (after pool.txCount incremented)
    const mint = {
        id: `${transaction.id}#${pool.txCount}`,
        transaction_id: transaction.id,
        timestamp: transaction.timestamp,
        pool_id: pool.id,
        token0_id: pool.token0_id,
        token1_id: pool.token1_id,
        owner: event.params.owner,
        sender: event.params.sender,
        origin: event.transaction.from?.toLowerCase() || '',
        amount: event.params.amount,
        amount0: amount0,
        amount1: amount1,
        amountUSD: amountUSD,
        tickLower: event.params.tickLower,
        tickUpper: event.params.tickUpper,
        logIndex: BigInt(event.logIndex),
        firstTokenUsdPrice: pool.token0Price,
        secondTokenUsdPrice: pool.token1Price,
    };

    // tick entities
    const lowerTickIdx = event.params.tickLower;
    const upperTickIdx = event.params.tickUpper;
    const ltId = `${pool.id}#${lowerTickIdx}`;
    const utId = `${pool.id}#${upperTickIdx}`;
    const amount = event.params.amount;

    const lowerTick = lowerTickRO ? { ...lowerTickRO } :
        { ...createTick(ltId, BigInt(lowerTickIdx), pool.id, timestamp, event.block.number) };

    const upperTick = upperTickRO ? { ...upperTickRO } :
        { ...createTick(utId, BigInt(upperTickIdx), pool.id, timestamp, event.block.number) };

    lowerTick.liquidityGross = lowerTick.liquidityGross + amount;
    lowerTick.liquidityNet = lowerTick.liquidityNet + amount;
    upperTick.liquidityGross = upperTick.liquidityGross + amount;
    upperTick.liquidityNet = upperTick.liquidityNet - amount;

    context.Tick.set(lowerTick);
    context.Tick.set(upperTick);

    // Subgraph: updateTickFeeVarsAndSave(lowerTick, event) and same for upperTick (read fee growth from pool, update tick, updateTickDayData)
    for (const [tick, tickIdx] of [[lowerTick, event.params.tickLower], [upperTick, event.params.tickUpper]] as const) {
        const feeVars = await context.effect(getPoolTickFeeGrowthEffect, {
            poolAddress: event.srcAddress,
            chainId: event.chainId,
            tickIdx: Number(tickIdx),
        });
        tick.feeGrowthOutside0X128 = BigInt(feeVars.feeGrowthOutside0X128);
        tick.feeGrowthOutside1X128 = BigInt(feeVars.feeGrowthOutside1X128);
        tick.liquidityGross = BigInt(feeVars.liquidityGross);
        tick.liquidityNet = BigInt(feeVars.liquidityNet);
        context.Tick.set(tick);
        await intervalUpdates.updateTickDayData(timestamp, tick, context);
    }

    await intervalUpdates.updateUniswapDayData(timestamp, event.chainId, factory, context);
    await intervalUpdates.updatePoolDayData(timestamp, pool, context);
    await intervalUpdates.updatePoolHourData(timestamp, pool, context);
    await intervalUpdates.updateTokenDayData(timestamp, token0, bundle, context);
    await intervalUpdates.updateTokenDayData(timestamp, token1, bundle, context);
    await intervalUpdates.updateTokenHourData(timestamp, token0, bundle, context);
    await intervalUpdates.updateTokenHourData(timestamp, token1, bundle, context);

    context.Token.set(token0);
    context.Token.set(token1);
    context.Pool.set(pool);
    context.Factory.set(factory);
    context.Mint.set(mint);
});
