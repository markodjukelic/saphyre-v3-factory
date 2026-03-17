import { Pool, Token, Bundle } from "generated";
import { CHAIN_CONFIGS } from "./utils/chains";
import { findNativePerToken, getNativePriceInUSD } from "./utils/pricing";
import { updatePoolDayData, updatePoolHourData } from "./utils/intervalUpdates";
import { makeId, bundleId } from "./utils/idFormat";
import { shouldLogPool } from "./utils/debugLogAllowlist";

Pool.Initialize.handler(async ({event, context}) => {
    const poolId = makeId(event.chainId, event.srcAddress.toLowerCase());
    let pool = await context.Pool.get(poolId);
    if (!pool) return;

    let [bundle, token0, token1] = await Promise.all([
        context.Bundle.get(bundleId(event.chainId)),
        context.Token.get(pool.token0_id),
        context.Token.get(pool.token1_id)
    ]);

    if (!bundle || !token0 || !token1) return;

    const {
        stablecoinWrappedNativePoolId,
        stablecoinIsToken0,
        wrappedNativeAddress,
        stablecoinAddresses,
        minimumNativeLocked,
    } = CHAIN_CONFIGS[event.chainId];

    // update pool sqrt price and tick
    pool = {
        ...pool,
        sqrtPrice: event.params.sqrtPriceX96,
        tick: event.params.tick
    };

    if (context.log && shouldLogPool(poolId)) {
        context.log.info(
            `[Initialize] pool_id=${poolId} block=${event.block.number} sqrtPrice=${pool.sqrtPrice} tick=${pool.tick}`
        );
    }

    context.Pool.set(pool);

    // update ETH price now that prices could have changed
    bundle = {
        ...bundle,
        ethPriceUSD: await getNativePriceInUSD(
            context, 
            event.chainId, 
            stablecoinWrappedNativePoolId, 
            stablecoinIsToken0
        )
    };

    context.Bundle.set(bundle);

    await updatePoolDayData(event.block.timestamp, pool, context);
    await updatePoolHourData(event.block.timestamp, pool, context);

    // update token prices
    const [derivedETH_t0, derivedETH_t1] = await Promise.all([
        findNativePerToken(
            context,
            token0,
            bundle,
            wrappedNativeAddress,
            stablecoinAddresses,
            minimumNativeLocked,
        ),
        findNativePerToken(
            context,
            token1,
            bundle,
            wrappedNativeAddress,
            stablecoinAddresses,
            minimumNativeLocked,
        )
    ]);

    token0 = {
        ...token0,
        derivedETH: derivedETH_t0
    };

    token1 = {
        ...token1,
        derivedETH: derivedETH_t1
    };

    context.Token.set(token0);
    context.Token.set(token1);
});
