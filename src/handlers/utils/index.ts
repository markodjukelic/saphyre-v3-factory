import { BigDecimal, handlerContext, Transaction } from "generated";
import { ZERO_BD, ONE_BD, ZERO_BI, ONE_BI } from "./constants";

export function isAddressInList(address: string, list: string[]): boolean {
    address = address.toLowerCase();

    for (const item of list) {
        if (address === item.toLowerCase()) {
            return true;
        }
    }
    
    return false;
}

export function exponentToBigDecimal(decimals: bigint): BigDecimal {
    let resultString = "1";

    for (let i = 0n; i < decimals; i++) {
        resultString += "0";
    }

    return new BigDecimal(resultString);
}

// return 0 if denominator is 0 in division
export function safeDiv(amount0: BigDecimal, amount1: BigDecimal): BigDecimal {
    return amount1.eq(ZERO_BD) ? ZERO_BD : amount0.div(amount1);
}

/**
 * Implements exponentiation by squaring
 * (see https://en.wikipedia.org/wiki/Exponentiation_by_squaring )
 * to minimize the number of BigDecimal operations and their impact on performance.
 */
export function _fastExponentiation(
    value: BigDecimal,
    power: bigint
): BigDecimal {
    if (power < ZERO_BI) {
        const result = _fastExponentiation(value, -power);
        return safeDiv(ONE_BD, result);
    }

    if (power === ZERO_BI) {
        return ONE_BD;
    }

    if (power === ONE_BI) {
        return value;
    }

    const halfPower = power / 2n;
    const halfResult = _fastExponentiation(value, halfPower);

    // Use the fact that x ^ (2n) = (x ^ n) * (x ^ n) and we can compute (x ^ n) only once.
    let result = halfResult.times(halfResult);

    // For odd powers, x ^ (2n + 1) = (x ^ 2n) * x
    if (power % 2n === ONE_BI) {
        result = result.times(value);
    }

    return result;
}

// For fast testing. Not to be used in production.
export function fastExponentiation(
    value: BigDecimal,
    power: bigint
): BigDecimal {
    const res = parseFloat(value.toString()) ** parseInt(power.toString());
    return new BigDecimal(res.toString());
}

export const NULL_ETH_HEX_STRING =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

export function isNullEthValue(value: string): boolean {
    return value === NULL_ETH_HEX_STRING;
}

/** Subgraph: feeTierToTickSpacing - used in swap handler for tick updates */
export function feeTierToTickSpacing(feeTier: bigint): bigint {
    if (feeTier === BigInt(10000)) return BigInt(200);
    if (feeTier === BigInt(3000)) return BigInt(60);
    if (feeTier === BigInt(500)) return BigInt(10);
    if (feeTier === BigInt(100)) return BigInt(1);
    throw new Error("Unexpected fee tier");
}

/** Interpret uint256 as int256 (two's complement). Some runtimes decode Swap amount0/amount1 as unsigned. */
const INT256_MAX = 2n ** 255n - 1n;
export function int256ToSignedBigInt(value: bigint): bigint {
    return value > INT256_MAX ? value - 2n ** 256n : value;
}

/** Subgraph fetchTokenTotalSupply casts to i32 (takes lower 32 bits). Match for parity. */
export function truncateTotalSupplyToSubgraphCompat(value: bigint): bigint {
    return value % (2n ** 32n);
}

export function convertTokenToDecimal(
    tokenAmount: bigint,
    exchangeDecimals: bigint
): BigDecimal {
    const val = new BigDecimal(tokenAmount.toString());
    return (exchangeDecimals === ZERO_BI) ? val : val.div(exponentToBigDecimal(exchangeDecimals));
}

/** Read gasUsed from event.transaction (when included via field_selection transaction_fields). */
export function getTransactionGasUsed(tx: unknown): bigint | undefined {
    const used = tx != null && typeof tx === 'object' && 'gasUsed' in tx ? (tx as { gasUsed?: bigint | number }).gasUsed : undefined;
    return used != null ? BigInt(used) : undefined;
}

/** Read gas (gas limit) from event.transaction (when included via field_selection transaction_fields). */
export function getTransactionGasLimit(tx: unknown): bigint | undefined {
    const gas = tx != null && typeof tx === 'object' && 'gas' in tx ? (tx as { gas?: bigint | number }).gas : undefined;
    return gas != null ? BigInt(gas) : undefined;
}

export interface GasDebugInfo {
    gasUsed?: bigint;
    gasLimit?: bigint;
    blockGasLimit?: bigint;
    gasPrice?: bigint;
    subgraphExpectedGasUsed?: string;
}

export async function loadTransaction(
    txHash: string,
    blockNumber: number,
    timestamp: number,
    gasPrice: bigint,
    context: handlerContext,
    gasUsed?: bigint,
    gasLimit?: bigint,
    logDebug?: boolean,
    gasDebugInfo?: GasDebugInfo
): Promise<Transaction> {
    const txRO = await context.Transaction.get(txHash);
    const transaction = txRO
        ? { ...txRO }
        : {
              id: txHash,
              blockNumber: 0,
              timestamp: 0,
              gasUsed: ZERO_BI,
              gasPrice: ZERO_BI,
          };

    transaction.blockNumber = blockNumber;
    transaction.timestamp = timestamp;
    transaction.gasPrice = gasPrice;
    // Subgraph stores gasLimit in gasUsed field (e.g. Sei chain); use gasLimit when available for parity
    if (gasLimit !== undefined && gasLimit !== null) {
        transaction.gasUsed = gasLimit;
    } else if (gasUsed !== undefined && gasUsed !== null) {
        transaction.gasUsed = gasUsed;
    }

    if (context.log && logDebug) {
        const g = gasDebugInfo ?? {};
        const gasUsedVal = g.gasUsed ?? gasUsed;
        const gasLimitVal = g.gasLimit ?? gasLimit;
        context.log.info(
            `[Transaction] id=${txHash} gasUsed=${gasUsedVal?.toString() ?? "undefined"} gasLimit=${gasLimitVal?.toString() ?? "undefined"} blockGasLimit=${g.blockGasLimit?.toString() ?? "undefined"} storing=${transaction.gasUsed} subgraph_expected=${g.subgraphExpectedGasUsed ?? "?"}`
        );
    }

    context.Transaction.set(transaction as Transaction);
    return transaction as Transaction;
}