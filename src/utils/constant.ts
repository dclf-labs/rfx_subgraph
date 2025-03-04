import { Address, BigDecimal, BigInt } from "@graphprotocol/graph-ts";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const ZERO_BI = BigInt.fromI32(0);
export const ONE_BI = BigInt.fromI32(1);
export const ZERO_BD = BigDecimal.fromString("0");
export const ONE_BD = BigDecimal.fromString("1");
export const BI_18 = BigInt.fromI32(18);
export const BYTES_ONE = Address.fromI32(1);
export const MIN_BD = BigDecimal.fromString("0.000000000000000001");
export const UPDATE_INTERVAL = BigInt.fromI32(60);
export const decimalsOracle = BigInt.fromI32(8);
export const CENT_BI = BigInt.fromI32(100);

