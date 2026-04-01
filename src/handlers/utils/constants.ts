import { BigDecimal } from "generated";

export const ADDRESS_ZERO = '0x0000000000000000000000000000000000000000'
export const FACTORY_ADDRESS = '0x179D9a5592Bc77050796F7be28058c51cA575df4'

export const ZERO_BI = BigInt(0)
export const ONE_BI = BigInt(1)
export const ZERO_BD = BigDecimal('0')
export const ONE_BD = BigDecimal('1')
export const BI_18 = BigInt(18)

export const FALLBACK_POOL_FEE_GROWTH = {
  feeGrowthGlobal0X128: "0",
  feeGrowthGlobal1X128: "0",
} as const;

export const FALLBACK_TICK_FEE_VARS = {
  feeGrowthOutside0X128: "0",
  feeGrowthOutside1X128: "0",
  liquidityGross: "0",
  liquidityNet: "0",
} as const;
