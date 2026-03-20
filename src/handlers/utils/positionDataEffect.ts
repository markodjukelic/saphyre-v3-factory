import { createEffect, S } from "envio";
import { createPublicClient, http } from "viem";
import * as dotenv from "dotenv";

dotenv.config();

const NPM_POSITIONS_ABI = [
  {
    inputs: [{ name: "tokenId", type: "uint256" }],
    name: "positions",
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const FACTORY_GET_POOL_ABI = [
  {
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    name: "getPool",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function getRpcUrl(chainId: number): string {
  switch (chainId) {
    case 1329:
      return process.env.ENVIO_SEI_RPC_URL || "https://evm-rpc.sei-apis.com";
    default:
      throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
}

const clients: Record<number, ReturnType<typeof createPublicClient>> = {};

export const getPositionDataEffect = createEffect(
  {
    name: "getPositionData",
    input: {
      npmAddress: S.string,
      tokenId: S.string,
      chainId: S.number,
      factoryAddress: S.string,
      blockNumber: S.number,
    },
    output: {
      poolAddress: S.string,
      token0: S.string,
      token1: S.string,
      tickLower: S.number,
      tickUpper: S.number,
      feeGrowthInside0LastX128: S.string,
      feeGrowthInside1LastX128: S.string,
    },
    rateLimit: { calls: 10000, per: "second" },
    cache: true,
  },
  async ({ input }) => {
    // Dummy data for testing – remove this return to use real RPC data
    return {
      poolAddress: "0x0000000000000000000000000000000000000000",
      token0: "0x0000000000000000000000000000000000000000",
      token1: "0x0000000000000000000000000000000000000000",
      tickLower: 0,
      tickUpper: 0,
      feeGrowthInside0LastX128: "0",
      feeGrowthInside1LastX128: "0",
    };

    const { npmAddress, tokenId, chainId, factoryAddress, blockNumber } = input;
    if (!clients[chainId]) {
      clients[chainId] = createPublicClient({
        transport: http(getRpcUrl(chainId), { batch: true }),
      });
    }
    const client = clients[chainId];
    const block = BigInt(blockNumber);

    // Read at the event's block (matches subgraph: contract calls are in block context).
    const positionResult = await client.readContract({
      address: npmAddress as `0x${string}`,
      abi: NPM_POSITIONS_ABI,
      functionName: "positions",
      args: [BigInt(tokenId)],
      blockNumber: block,
    });

    const [token0, token1, fee, tickLower, tickUpper, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = [
      positionResult[2],
      positionResult[3],
      positionResult[4],
      positionResult[5],
      positionResult[6],
      positionResult[8],
      positionResult[9],
    ];

    const poolAddress = await client.readContract({
      address: factoryAddress as `0x${string}`,
      abi: FACTORY_GET_POOL_ABI,
      functionName: "getPool",
      args: [token0, token1, fee],
      blockNumber: block,
    });

    return {
      poolAddress: (poolAddress as string).toLowerCase(),
      token0: (token0 as string).toLowerCase(),
      token1: (token1 as string).toLowerCase(),
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      feeGrowthInside0LastX128: feeGrowthInside0LastX128.toString(),
      feeGrowthInside1LastX128: feeGrowthInside1LastX128.toString(),
    };
  }
);
