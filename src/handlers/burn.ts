import { Pool, Token, Bundle, Factory, Burn, Tick } from "generated";
import { CHAIN_CONFIGS } from "./utils/chains";
import { convertTokenToDecimal, loadTransaction, getTransactionGasUsed, getTransactionGasLimit } from './utils/index';
import { ONE_BI, ZERO_BI } from './utils/constants';
import * as intervalUpdates from './utils/intervalUpdates';
import { getPoolTickFeeGrowthEffect } from './utils/poolStateEffect';
import { makeId, bundleId, SUBGRAPH_COMPATIBLE_IDS } from './utils/idFormat';
import { shouldLogPool, shouldLogBurn, shouldLogTransaction } from './utils/debugLogAllowlist';
import { SUBGRAPH_EXPECTED } from './utils/debugLogSubgraphExpected';

Pool.Burn.handler(async ({ event, context }) => {
    const { factoryAddress } = CHAIN_CONFIGS[event.chainId];
    const factoryIdBase = SUBGRAPH_COMPATIBLE_IDS ? factoryAddress : factoryAddress.toLowerCase();
    const poolId = makeId(event.chainId, event.srcAddress.toLowerCase());
    
    // tick entities
    const lowerTickId = `${poolId}#${event.params.tickLower}`;
    const upperTickId = `${poolId}#${event.params.tickUpper}`;

    const poolRO = await context.Pool.get(poolId);
    if (!poolRO) return;

    const [bundle, factoryRO, token0RO, token1RO, lowerTickRO, upperTickRO] = await Promise.all([
        context.Bundle.get(bundleId(event.chainId)),
        context.Factory.get(makeId(event.chainId, factoryIdBase)),
        context.Token.get(poolRO.token0_id),
        context.Token.get(poolRO.token1_id),
        context.Tick.get(lowerTickId),
        context.Tick.get(upperTickId),
    ]);

    if (!bundle || !factoryRO || !token0RO || !token1RO) return;

    const factory = { ...factoryRO };
    const pool = { ...poolRO };
    const token0 = { ...token0RO };
    const token1 = { ...token1RO };
    const timestamp = event.block.timestamp;

    const amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals);
    const amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals);

    const amountUSD = amount0
        .times(token0.derivedETH.times(bundle.ethPriceUSD))
        .plus(amount1.times(token1.derivedETH.times(bundle.ethPriceUSD)));

    factory.txCount = factory.txCount + ONE_BI;
    factory.burnCount = factory.burnCount + ONE_BI;
    token0.txCount = token0.txCount + ONE_BI;
    token1.txCount = token1.txCount + ONE_BI;
    pool.txCount = pool.txCount + ONE_BI;
    pool.burnCount = pool.burnCount + ONE_BI;

    // Pools liquidity tracks the currently active liquidity given pools current tick.
    // We only want to update it on burn if the position being burnt includes the current tick.
    if (
        typeof (pool.tick) === 'bigint' &&
        event.params.tickLower <= pool.tick &&
        event.params.tickUpper > pool.tick
    ) {
        // todo: this liquidity can be calculated from the real reserves and
        // current price instead of incrementally from every burned amount which
        // may not be accurate: https://linear.app/uniswap/issue/DAT-336/fix-pool-liquidity
        pool.liquidity = pool.liquidity - event.params.amount;
    }

    // Subgraph: subtract burn amounts from token and pool TVL, then recompute pool/factory TVL
    factory.totalValueLockedETH = factory.totalValueLockedETH.minus(pool.totalValueLockedETH);
    token0.totalValueLocked = token0.totalValueLocked.minus(amount0);
    token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedETH.times(bundle.ethPriceUSD));
    token1.totalValueLocked = token1.totalValueLocked.minus(amount1);
    token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedETH.times(bundle.ethPriceUSD));
    pool.totalValueLockedToken0 = pool.totalValueLockedToken0.minus(amount0);
    pool.totalValueLockedToken1 = pool.totalValueLockedToken1.minus(amount1);
    pool.totalValueLockedETH = pool.totalValueLockedToken0
        .times(token0.derivedETH)
        .plus(pool.totalValueLockedToken1.times(token1.derivedETH));
    pool.totalValueLockedUSD = pool.totalValueLockedETH.times(bundle.ethPriceUSD);
    factory.totalValueLockedETH = factory.totalValueLockedETH.plus(pool.totalValueLockedETH);
    factory.totalValueLockedUSD = factory.totalValueLockedETH.times(bundle.ethPriceUSD);

    // burn entity
    const burnId = `${event.transaction.hash}#${pool.txCount}`;
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

    // Subgraph: burn.id = transaction.id + '#' + pool.txCount (after pool.txCount incremented)
    const burn: Burn = {
        id: burnId,
        transaction_id: transaction.id,
        timestamp: transaction.timestamp,
        pool_id: pool.id,
        token0_id: pool.token0_id,
        token1_id: pool.token1_id,
        owner: event.params.owner,
        origin: event.transaction.from?.toLowerCase() || '',
        amount: event.params.amount,
        amount0: amount0,
        amount1: amount1,
        amountUSD: amountUSD,
        tickLower: BigInt(event.params.tickLower),
        tickUpper: BigInt(event.params.tickUpper),
        logIndex: BigInt(event.logIndex),
        firstTokenUsdPrice: pool.token0Price,
        secondTokenUsdPrice: pool.token1Price,
    };

    if (context.log && (shouldLogPool(poolId) || shouldLogBurn(burnId))) {
        const exp = SUBGRAPH_EXPECTED.Burn[burnId.toLowerCase()];
        context.log.info(
            `[Burn] id=${burnId} pool_id=${poolId} block=${event.block.number} pool_txCount=${pool.txCount} event.params.amount=${event.params.amount} event.params.amount0=${event.params.amount0} event.params.amount1=${event.params.amount1} amount0=${amount0.toString()} amount1=${amount1.toString()} subgraph_amount=${exp?.amount ?? "?"} subgraph_amount0=${exp?.amount0 ?? "?"} subgraph_amount1=${exp?.amount1 ?? "?"}`
        );
    }

    if (lowerTickRO && upperTickRO) {
        const amount = event.params.amount;
        const lowerTick = { ...lowerTickRO };
        const upperTick = { ...upperTickRO };

        // Subgraph: lower -= amount, upper += amount for liquidityNet (Uniswap v3 convention)
        lowerTick.liquidityGross = lowerTick.liquidityGross - amount;
        lowerTick.liquidityNet = lowerTick.liquidityNet - amount;
        upperTick.liquidityGross = upperTick.liquidityGross - amount;
        upperTick.liquidityNet = upperTick.liquidityNet + amount;

        context.Tick.set(lowerTick);
        context.Tick.set(upperTick);

        // Subgraph: updateTickFeeVarsAndSave for each tick, then updateTickDayData
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
    context.Burn.set(burn);
});
