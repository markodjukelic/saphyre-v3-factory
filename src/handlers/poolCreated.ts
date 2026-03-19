import { Factory, Bundle, Token } from "generated";
import type { Entities_Pool_t as Pool } from "generated";
import { ZERO_BD, ZERO_BI, ONE_BI, ADDRESS_ZERO } from "./utils/constants";
import { CHAIN_CONFIGS } from "./utils/chains";
import { isAddressInList, truncateTotalSupplyToSubgraphCompat } from "./utils/index";
import { getTokenMetadataEffect } from "./utils/tokenMetadataEffect";
import { makeId, bundleId, SUBGRAPH_COMPATIBLE_IDS } from "./utils/idFormat";
import { shouldLogToken } from "./utils/debugLogAllowlist";
import { SUBGRAPH_EXPECTED } from "./utils/debugLogSubgraphExpected";

Factory.PoolCreated.contractRegister(({ event, context }) => {
  context.addPool(event.params.pool);
});

Factory.PoolCreated.handler(async ({ event, context }) => {
  const { factoryAddress, poolsToSkip, whitelistTokens } = CHAIN_CONFIGS[event.chainId];
  const factoryIdBase = SUBGRAPH_COMPATIBLE_IDS ? factoryAddress : factoryAddress.toLowerCase();
  const { token0Address, token1Address } = {
    token0Address: event.params.token0,
    token1Address: event.params.token1,
  };

  const METADATA_FALLBACK = { name: "unknown", symbol: "UNKNOWN", decimals: 18, totalSupply: "0" };

  const [factoryRO, token0RO, token1RO, token0Metadata, token1Metadata] =
    await Promise.all([
      context.Factory.get(makeId(event.chainId, factoryIdBase)),
      context.Token.get(makeId(event.chainId, token0Address.toLowerCase())),
      context.Token.get(makeId(event.chainId, token1Address.toLowerCase())),
      context.effect(getTokenMetadataEffect, { address: token0Address, chainId: event.chainId })
        .catch((err: unknown) => {
          context.log.error(`Failed to fetch metadata for token0 ${token0Address} on chain ${event.chainId}`, err as Error);
          context.log.warn(`[Token decimals] token0=${token0Address} using FALLBACK decimals=18 - may cause 10^x volumeUSD errors if token is 6 decimals`);
          return METADATA_FALLBACK;
        }),
      context.effect(getTokenMetadataEffect, { address: token1Address, chainId: event.chainId })
        .catch((err: unknown) => {
          context.log.error(`Failed to fetch metadata for token1 ${token1Address} on chain ${event.chainId}`, err as Error);
          context.log.warn(`[Token decimals] token1=${token1Address} using FALLBACK decimals=18 - may cause 10^x volumeUSD errors if token is 6 decimals`);
          return METADATA_FALLBACK;
        }),
    ]);

  // temp fix
  if (isAddressInList(event.params.pool, poolsToSkip)) {
    return;
  }

  let factory;

  if (factoryRO) {
    factory = { ...factoryRO };
  } else {
    factory = {
      id: makeId(event.chainId, factoryIdBase),
      poolCount: ZERO_BI,
      txCount: ZERO_BI,
      mintCount: ZERO_BI,
      burnCount: ZERO_BI,
      swapCount: ZERO_BI,
      totalVolumeETH: ZERO_BD,
      totalVolumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      totalFeesUSD: ZERO_BD,
      totalFeesETH: ZERO_BD,
      totalValueLockedETH: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      totalValueLockedETHUntracked: ZERO_BD,
      owner: ADDRESS_ZERO,
    };

    // create new bundle for tracking eth price
    const bundle: Bundle = {
      id: bundleId(event.chainId),
      ethPriceUSD: ZERO_BD,
    };

    context.Bundle.set(bundle);
  }

  factory.poolCount = factory.poolCount + ONE_BI;

  // Create token objects using the metadata we fetched in the loader
  const tokens = [];

  // Create token0 (subgraph: fetchTokenTotalSupply casts to i32; we truncate to match)
  if (token0RO) {
    tokens[0] = { ...token0RO };
    if (context.log && shouldLogToken(makeId(event.chainId, token0Address.toLowerCase()))) {
      const exp = SUBGRAPH_EXPECTED.Token[token0Address.toLowerCase()];
      context.log.info(`[Token] token0=${token0Address} decimals=${token0RO.decimals} totalSupply=${token0RO.totalSupply} subgraph_decimals=${exp?.decimals ?? "?"} subgraph_totalSupply=${exp?.totalSupply ?? "?"}`);
    }
  } else {
    const rawTotalSupply0 = BigInt(token0Metadata.totalSupply ?? "0");
    const totalSupply0 = truncateTotalSupplyToSubgraphCompat(rawTotalSupply0);
    const token0Id = makeId(event.chainId, token0Address.toLowerCase());
    if (context.log && shouldLogToken(token0Id)) {
      const exp = SUBGRAPH_EXPECTED.Token[token0Address.toLowerCase()];
      context.log.info(`[Token] token0=${token0Address} decimals=${token0Metadata.decimals} totalSupply=${totalSupply0} subgraph_decimals=${exp?.decimals ?? "?"} subgraph_totalSupply=${exp?.totalSupply ?? "?"}`);
    }
    tokens[0] = {
      id: token0Id,
      symbol: token0Metadata.symbol,
      name: token0Metadata.name,
      decimals: BigInt(token0Metadata.decimals),
      totalSupply: totalSupply0,
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      txCount: ZERO_BI,
      poolCount: ZERO_BI,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      derivedETH: ZERO_BD,
      whitelistPools: [],
    };
  }

  // Create token1 (subgraph: fetchTokenTotalSupply casts to i32; we truncate to match)
  if (token1RO) {
    tokens[1] = { ...token1RO };
    if (context.log && shouldLogToken(makeId(event.chainId, token1Address.toLowerCase()))) {
      const exp = SUBGRAPH_EXPECTED.Token[token1Address.toLowerCase()];
      context.log.info(`[Token] token1=${token1Address} decimals=${token1RO.decimals} totalSupply=${token1RO.totalSupply} subgraph_decimals=${exp?.decimals ?? "?"} subgraph_totalSupply=${exp?.totalSupply ?? "?"}`);
    }
  } else {
    const rawTotalSupply1 = BigInt(token1Metadata.totalSupply ?? "0");
    const totalSupply1 = truncateTotalSupplyToSubgraphCompat(rawTotalSupply1);
    const token1Id = makeId(event.chainId, token1Address.toLowerCase());
    if (context.log && shouldLogToken(token1Id)) {
      const exp = SUBGRAPH_EXPECTED.Token[token1Address.toLowerCase()];
      context.log.info(`[Token] token1=${token1Address} decimals=${token1Metadata.decimals} totalSupply=${totalSupply1} subgraph_decimals=${exp?.decimals ?? "?"} subgraph_totalSupply=${exp?.totalSupply ?? "?"}`);
    }
    tokens[1] = {
      id: token1Id,
      symbol: token1Metadata.symbol,
      name: token1Metadata.name,
      decimals: BigInt(token1Metadata.decimals),
      totalSupply: totalSupply1,  // truncated to match subgraph i32 cast
      volume: ZERO_BD,
      volumeUSD: ZERO_BD,
      untrackedVolumeUSD: ZERO_BD,
      feesUSD: ZERO_BD,
      txCount: ZERO_BI,
      poolCount: ZERO_BI,
      totalValueLocked: ZERO_BD,
      totalValueLockedUSD: ZERO_BD,
      totalValueLockedUSDUntracked: ZERO_BD,
      derivedETH: ZERO_BD,
      whitelistPools: [],
    };
  }

  const pool: Pool = {
    id: makeId(event.chainId, event.params.pool.toLowerCase()),
    createdAtTimestamp: BigInt(event.block.timestamp),
    createdAtBlockNumber: BigInt(event.block.number),
    token0_id: tokens[0].id,
    token1_id: tokens[1].id,
    feeTier: event.params.fee,
    liquidity: ZERO_BI,
    sqrtPrice: ZERO_BI,
    feeGrowthGlobal0X128: ZERO_BI,
    feeGrowthGlobal1X128: ZERO_BI,
    token0Price: ZERO_BD,
    token1Price: ZERO_BD,
    tick: 0n, // subgraph does not set tick at creation; set by Initialize
    observationIndex: ZERO_BI,
    volumeToken0: ZERO_BD,
    volumeToken1: ZERO_BD,
    volumeUSD: ZERO_BD,
    untrackedVolumeUSD: ZERO_BD,
    feesUSD: ZERO_BD,
    txCount: ZERO_BI,
    collectedFeesToken0: ZERO_BD,
    collectedFeesToken1: ZERO_BD,
    collectedFeesUSD: ZERO_BD,
    totalValueLockedToken0: ZERO_BD,
    totalValueLockedToken1: ZERO_BD,
    totalValueLockedETH: ZERO_BD,
    totalValueLockedUSD: ZERO_BD,
    totalValueLockedUSDUntracked: ZERO_BD,
    liquidityProviderCount: ZERO_BI,
    mintCount: ZERO_BI,
    swapCount: ZERO_BI,
    burnCount: ZERO_BI,
  };

  // update white listed pools (subgraph: WHITELIST_TOKENS.includes(token0.id) -> add pool to token1.whitelistPools)
  if (isAddressInList(token0Address, whitelistTokens)) {
    tokens[1].whitelistPools = [...(tokens[1].whitelistPools || []), pool.id];
  }
  if (isAddressInList(token1Address, whitelistTokens)) {
    tokens[0].whitelistPools = [...(tokens[0].whitelistPools || []), pool.id];
  }

  context.Pool.set(pool);
  context.Token.set(tokens[0]);
  context.Token.set(tokens[1]);
  context.Factory.set(factory);
});