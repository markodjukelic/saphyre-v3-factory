import { createEffect, S } from "envio";
import { createPublicClient, http, getContract, type PublicClient } from "viem";
import * as dotenv from "dotenv";

dotenv.config();

const getRpcUrl = (chainId: number): string => {
  switch (chainId) {
    case 1: return process.env.ENVIO_MAINNET_RPC_URL || "https://eth.drpc.org";
    case 42161: return process.env.ENVIO_ARBITRUM_RPC_URL || "https://arbitrum.drpc.org";
    case 10: return process.env.ENVIO_OPTIMISM_RPC_URL || "https://optimism.drpc.org";
    case 8453: return process.env.ENVIO_BASE_RPC_URL || "https://base.drpc.org";
    case 137: return process.env.ENVIO_POLYGON_RPC_URL || "https://polygon.drpc.org";
    case 43114: return process.env.ENVIO_AVALANCHE_RPC_URL || "https://avalanche.drpc.org";
    case 56: return process.env.ENVIO_BSC_RPC_URL || "https://bsc.drpc.org";
    case 81457: return process.env.ENVIO_BLAST_RPC_URL || "https://blast.drpc.org";
    case 7777777: return process.env.ENVIO_ZORA_RPC_URL || "https://zora.drpc.org";
    case 1868: return process.env.ENVIO_SONIEUM_RPC_URL || "https://sonieum.drpc.org";
    case 130: return process.env.ENVIO_UNICHAIN_RPC_URL || "https://unichain.drpc.org";
    case 57073: return process.env.ENVIO_INK_RPC_URL || "https://ink.drpc.org";
    case 1329: return process.env.ENVIO_SEI_RPC_URL || "https://sei.drpc.org";
    default: throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
};

const POOL_FEE_GROWTH_ABI = [
  {
    inputs: [],
    name: "feeGrowthGlobal0X128",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "feeGrowthGlobal1X128",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const clients: Record<number, PublicClient> = {};

export const getPoolFeeGrowthEffect = createEffect(
  {
    name: "getPoolFeeGrowth",
    input: {
      poolAddress: S.string,
      chainId: S.number,
      blockNumber: S.bigint,
    },
    output: {
      feeGrowthGlobal0X128: S.string,
      feeGrowthGlobal1X128: S.string,
    },
    rateLimit: { calls: 50, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    const { poolAddress, chainId, blockNumber } = input;
    try {
      if (!clients[chainId]) {
        clients[chainId] = createPublicClient({
          transport: http(getRpcUrl(chainId), { batch: true }),
        });
      }
      const contract = getContract({
        address: poolAddress as `0x${string}`,
        abi: POOL_FEE_GROWTH_ABI,
        client: clients[chainId],
      });
      const [feeGrowthGlobal0X128, feeGrowthGlobal1X128] = await Promise.all([
        contract.read.feeGrowthGlobal0X128({ blockNumber }),
        contract.read.feeGrowthGlobal1X128({ blockNumber }),
      ]);
      return {
        feeGrowthGlobal0X128: feeGrowthGlobal0X128.toString(),
        feeGrowthGlobal1X128: feeGrowthGlobal1X128.toString(),
      };
    } catch (e) {
      throw new Error(
        `getPoolFeeGrowth RPC failed (chainId=${chainId}, pool=${poolAddress}, block=${blockNumber}): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
);

/** Subgraph updateTickFeeVarsAndSave: read pool.ticks(tickIdx) and return feeGrowthOutside0X128, feeGrowthOutside1X128 (indices 2,3) */
const POOL_TICKS_ABI = [
  {
    inputs: [{ name: "tick", type: "int24", internalType: "int24" }],
    name: "ticks",
    outputs: [
      { name: "liquidityGross", type: "uint128" },
      { name: "liquidityNet", type: "int128" },
      { name: "feeGrowthOutside0X128", type: "uint256" },
      { name: "feeGrowthOutside1X128", type: "uint256" },
      { name: "tickCumulativeOutside", type: "int56" },
      { name: "secondsPerLiquidityOutsideX128", type: "uint160" },
      { name: "secondsOutside", type: "uint32" },
      { name: "initialized", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

export const getPoolTickFeeGrowthEffect = createEffect(
  {
    name: "getPoolTickFeeGrowth",
    input: {
      poolAddress: S.string,
      chainId: S.number,
      tickIdx: S.number,
      blockNumber: S.bigint,
    },
    output: {
      feeGrowthOutside0X128: S.string,
      feeGrowthOutside1X128: S.string,
      liquidityGross: S.string,
      liquidityNet: S.string,
    },
    rateLimit: { calls: 50, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    const { poolAddress, chainId, tickIdx, blockNumber } = input;
    try {
      if (!clients[chainId]) {
        clients[chainId] = createPublicClient({
          transport: http(getRpcUrl(chainId), { batch: true }),
        });
      }
      const contract = getContract({
        address: poolAddress as `0x${string}`,
        abi: POOL_TICKS_ABI,
        client: clients[chainId],
      });
      // int24: pass as number (viem encodes signed); tickIdx can be negative
      const result = await contract.read.ticks([tickIdx as number], { blockNumber });
      // result: liquidityGross (uint128), liquidityNet (int128), feeGrowthOutside0, feeGrowthOutside1, ...
      const liquidityNet = result[1]; // int128, may be negative; viem returns signed bigint
      return {
        feeGrowthOutside0X128: result[2].toString(),
        feeGrowthOutside1X128: result[3].toString(),
        liquidityGross: result[0].toString(),
        liquidityNet: liquidityNet.toString(),
      };
    } catch (e) {
      throw new Error(
        `getPoolTickFeeGrowth RPC failed (chainId=${chainId}, pool=${poolAddress}, tick=${tickIdx}, block=${blockNumber}): ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
);
