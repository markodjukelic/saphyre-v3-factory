/**
 * Subgraph expected values from comparison-2026-02-19 for debugging.
 * Used in logs to compare our computed values vs subgraph.
 */
export const SUBGRAPH_EXPECTED: {
  Token: Record<string, { decimals?: string; totalSupply?: string; totalValueLocked?: string; totalValueLockedUSD?: string; derivedETH?: string }>;
  Pool: Record<string, { feeGrowthGlobal0X128?: string; feeGrowthGlobal1X128?: string }>;
  Burn: Record<string, { amount?: string; amount0?: string; amount1?: string }>;
  Swap: Record<string, { amount0?: string; amount1?: string; amount0In?: string; amount1In?: string; amount0Out?: string; amount1Out?: string }>;
  Transaction: Record<string, { gasUsed?: string }>;
  Tick: Record<string, { feeGrowthOutside0X128?: string; feeGrowthOutside1X128?: string; liquidityNet?: string }>;
} = {
  Token: {
    "0x059a6b0ba116c63191182a0956cf697d0d2213ec": {
      decimals: "18",
      totalSupply: "16456",
      totalValueLocked: "94797.808085384631059892",
      totalValueLockedUSD: "69301.76483006641340704555576491121",
      derivedETH: "10.32244869252684493026842770392894",
    },
  },
  Pool: {
    "0x01430caba3b858561bb85e8ed1e4389740f7ef17": {
      feeGrowthGlobal0X128: "32730484962964291493238996360409218464257159",
      feeGrowthGlobal1X128: "4002115960291817554023080453123",
    },
  },
  Burn: {
    "0x00000204e493afc4a52e7c3dc73277c2976b6ff0902238307d560f5898fa5779#846212": {
      amount: "2327926055221496731214",
      amount0: "550098.93264",
      amount1: "615147.059875202955788502",
    },
  },
  Swap: {
    "0x00000204e493afc4a52e7c3dc73277c2976b6ff0902238307d560f5898fa5779#846206": {
      amount0: "1688.228829",
      amount1: "-1799.099998841628075718",
      amount0In: "1688.228829",
      amount1In: "0",
      amount0Out: "0",
      amount1Out: "1799.099998841628075718",
    },
  },
  Transaction: {
    "0x00000090ed37a80465ae911a34fdb39fcbbd1c2506c3cbd9521962698975c1e0": {
      gasUsed: "2000000",
    },
  },
  Tick: {
    "0x04f538d9065146e4fac4882f1ccf6d2786f8a9a4#-161200": {
      feeGrowthOutside0X128: "0",
      feeGrowthOutside1X128: "0",
      liquidityNet: "0",
    },
  },
};
