import { createEffect, S } from "envio";
import { createPublicClient, http, getContract, type PublicClient } from "viem";
import { ADDRESS_ZERO } from "./constants";
import { getChainConfig } from "./chains";
import * as dotenv from "dotenv";

dotenv.config();

const ERC20_ABI = [
  {
    inputs: [],
    name: "name",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const getRpcUrl = (chainId: number): string => {
  switch (chainId) {
    case 1:
      return process.env.ENVIO_MAINNET_RPC_URL || "https://eth.drpc.org";
    case 42161:
      return process.env.ENVIO_ARBITRUM_RPC_URL || "https://arbitrum.drpc.org";
    case 10:
      return process.env.ENVIO_OPTIMISM_RPC_URL || "https://optimism.drpc.org";
    case 8453:
      return process.env.ENVIO_BASE_RPC_URL || "https://base.drpc.org";
    case 137:
      return process.env.ENVIO_POLYGON_RPC_URL || "https://polygon.drpc.org";
    case 43114:
      return process.env.ENVIO_AVALANCHE_RPC_URL || "https://avalanche.drpc.org";
    case 56:
      return process.env.ENVIO_BSC_RPC_URL || "https://bsc.drpc.org";
    case 81457:
      return process.env.ENVIO_BLAST_RPC_URL || "https://blast.drpc.org";
    case 7777777:
      return process.env.ENVIO_ZORA_RPC_URL || "https://zora.drpc.org";
    case 1868:
      return process.env.ENVIO_SONIEUM_RPC_URL || "https://sonieum.drpc.org";
    case 130:
      return process.env.ENVIO_UNICHAIN_RPC_URL || "https://unichain.drpc.org";
    case 57073:
      return process.env.ENVIO_INK_RPC_URL || "https://ink.drpc.org";
    case 1329:
      return process.env.ENVIO_SEI_RPC_URL || "https://private-rpc.dragonswap.app";
    default:
      throw new Error(`No RPC URL configured for chainId ${chainId}`);
  }
};
// Cache of clients per chainId
const clients: Record<number, PublicClient> = {};

// Function to sanitize strings
function sanitizeString(str: string): string {
  if (!str) return "";
  return str.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

// Create the token metadata effect
export const getTokenMetadataEffect = createEffect(
  {
    name: "getTokenMetadata",
    input: {
      address: S.string,
      chainId: S.number,
    },
    output: {
      name: S.string,
      symbol: S.string,
      decimals: S.number,
      totalSupply: S.string,
    },
    rateLimit: { calls: 50, per: "second" },
    cache: true, 
  },
  async ({ input, context }) => {
    const { address, chainId } = input;
    // Normalize address only for comparisons, not for cache keys
    const normalizedAddress = address.toLowerCase();


    try {
      // Handle native token (no contract to call)
      if (normalizedAddress === ADDRESS_ZERO.toLowerCase()) {
        const chainConfig = getChainConfig(chainId);
        const result = {
          name: chainConfig.nativeTokenDetails.name,
          symbol: chainConfig.nativeTokenDetails.symbol,
          decimals: Number(chainConfig.nativeTokenDetails.decimals),
          totalSupply: "0",
        };
        return result;
      }

      // Fetch from contract (matches subgraph: no token overrides for SEI)
      if (!clients[chainId]) {
        clients[chainId] = createPublicClient({
          transport: http(getRpcUrl(chainId), { batch: true }),
        });
        context.log.info(
          `Created client for chain ${chainId} with batching enabled`
        );
      }

      // Create contract instance with proper typing
      const contract = getContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        client: clients[chainId],
      });

      const [nameResult, symbolResult, decimalsResult, totalSupplyResult] =
        await Promise.all([
          contract.read.name({}),
          contract.read.symbol({}),
          contract.read.decimals({}),
          contract.read.totalSupply({}),
        ]);

      const name = sanitizeString(nameResult as string);
      if (!name) {
        throw new Error(`Empty name for token ${address} on chain ${chainId}`);
      }

      const symbol = sanitizeString(symbolResult as string);
      if (!symbol) {
        throw new Error(`Empty symbol for token ${address} on chain ${chainId}`);
      }

      return {
        name,
        symbol,
        decimals: decimalsResult as number,
        totalSupply: String(totalSupplyResult as bigint),
      };
    } catch (error) {
      context.log.error(
        `Error fetching metadata for ${address} on chain ${chainId}`,
        error as Error
      );
      throw error;
    }
  }
);
