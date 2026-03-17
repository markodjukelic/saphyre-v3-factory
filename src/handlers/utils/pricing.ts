import { Bundle, Token, BigDecimal, handlerContext } from "generated";
import { ADDRESS_ZERO, ONE_BD, ZERO_BD, ZERO_BI } from "./constants";
import { exponentToBigDecimal, safeDiv, isAddressInList } from "./index";
import { NativeTokenDetails } from "./nativeTokenDetails";
import { makeId } from "./idFormat";

const Q192 = BigInt(2) ** BigInt(192);

export function sqrtPriceX96ToTokenPrices(
  sqrtPriceX96: bigint,
  token0: Token,
  token1: Token,
  nativeTokenDetails: NativeTokenDetails
): BigDecimal[] {
  const addr0 = token0.id.includes("-") ? token0.id.split("-")[1]! : token0.id;
  const addr1 = token1.id.includes("-") ? token1.id.split("-")[1]! : token1.id;
  const token0Decimals = addr0 === ADDRESS_ZERO ? nativeTokenDetails.decimals : token0.decimals;
  const token1Decimals = addr1 === ADDRESS_ZERO ? nativeTokenDetails.decimals : token1.decimals;

  const num = new BigDecimal((sqrtPriceX96 * sqrtPriceX96).toString());
  const denom = new BigDecimal(Q192.toString());
  const price1 = exponentToBigDecimal(token0Decimals).times(num)
    .div(exponentToBigDecimal(token1Decimals).times(denom));
  const price0 = safeDiv(new BigDecimal("1"), price1);
  return [price0, price1];
}

export async function getNativePriceInUSD(
  context: handlerContext,
  chainId: number,
  stablecoinWrappedNativePoolId: string,
  stablecoinIsToken0: boolean
): Promise<BigDecimal> {
  const poolId = makeId(chainId, stablecoinWrappedNativePoolId.toLowerCase());
  const stablecoinWrappedNativePool = await context.Pool.get(poolId);

  if (stablecoinWrappedNativePool) {
    return stablecoinIsToken0
      ? stablecoinWrappedNativePool.token0Price
      : stablecoinWrappedNativePool.token1Price;
  }
  return ZERO_BD;
}

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export async function findNativePerToken(
  context: handlerContext,
  token: Token,
  bundle: Bundle,
  wrappedNativeAddress: string,
  stablecoinAddresses: string[],
  minimumNativeLocked: BigDecimal
): Promise<BigDecimal> {
  // When SUBGRAPH_COMPATIBLE_IDS, token.id is the address; otherwise "chainId-address"
  const tokenAddress = token.id.includes("-") ? token.id.split("-")[1]! : token.id;

  if (tokenAddress === wrappedNativeAddress.toLowerCase() || tokenAddress === ADDRESS_ZERO) {
    return ONE_BD;
  }

  if (isAddressInList(tokenAddress, stablecoinAddresses)) {
    return safeDiv(ONE_BD, bundle.ethPriceUSD);
  }

  const whiteList = await Promise.all(
    // Pool IDs already include chainId since we store them that way in whitelistPools
    token.whitelistPools.map(poolId => context.Pool.get(poolId))
  );
  let largestLiquidityETH = ZERO_BD;
  let priceSoFar = ZERO_BD;

  for (const pool of whiteList) {
    if (!pool || pool.liquidity <= ZERO_BI) { continue; }

    if (pool.token0_id === token.id) {
      const token1 = await context.Token.get(pool.token1_id);

      if (token1) {
        const ethLocked = pool.totalValueLockedToken1.times(token1.derivedETH);

        if (
          ethLocked.gt(largestLiquidityETH) &&
          ethLocked.gt(minimumNativeLocked)
        ) {
          largestLiquidityETH = ethLocked;
          priceSoFar = pool.token1Price.times(token1.derivedETH);
        }
      }
    }

    if (pool.token1_id === token.id) {
      const token0 = await context.Token.get(pool.token0_id);
      
      if (token0) {
        const ethLocked = pool.totalValueLockedToken0.times(token0.derivedETH);

        if (
          ethLocked.gt(largestLiquidityETH) &&
          ethLocked.gt(minimumNativeLocked)
        ) {
          largestLiquidityETH = ethLocked;
          priceSoFar = pool.token0Price.times(token0.derivedETH);
        }
      }
    }
  }

  return priceSoFar;
}

/**
 * Accepts tokens and amounts, return tracked amount in USD.
 * Subgraph: always returns tokenAmount0*price0USD + tokenAmount1*price1USD
 * (whitelist branching was commented out in subgraph)
 */
export function getTrackedAmountUSD(
  bundle: Bundle,
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  if (!bundle) return ZERO_BD;
  const price0USD = token0.derivedETH.times(bundle.ethPriceUSD);
  const price1USD = token1.derivedETH.times(bundle.ethPriceUSD);
  return tokenAmount0.times(price0USD).plus(tokenAmount1.times(price1USD));
}

export function calculateAmountUSD(
  amount0: BigDecimal,
  amount1: BigDecimal,
  token0DerivedETH: BigDecimal,
  token1DerivedETH: BigDecimal,
  ethPriceUSD: BigDecimal
): BigDecimal {
  return amount0
    .times(token0DerivedETH.times(ethPriceUSD))
    .plus(amount1.times(token1DerivedETH.times(ethPriceUSD)));
}