import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import { Wallet, UserState } from "../generated/schema";

// Shared helper functions
export function getOrCreateWallet(address: string): Wallet {
  let wallet = Wallet.load(address);
  
  if (wallet == null) {
    wallet = new Wallet(address);
    wallet.balance = BigInt.fromI32(0);
    wallet.estimateDeposit = BigInt.fromI32(0);
    wallet.lastUpdateTimestamp = BigInt.fromI32(0);
    wallet.lastDepositUpdateTimestamp = BigInt.fromI32(0);
    wallet.coinTimeAccumulator = BigInt.fromI32(0);
    wallet.transactionCount = BigInt.fromI32(0);
    wallet.save();
  }
  
  return wallet;
}

// Update wallet balance and accumulator
export function updateWalletBalanceAndAccumulator(wallet: Wallet, timestamp: BigInt): void {
  // Skip if this is the first update or timestamp hasn't changed
  if (wallet.lastDepositUpdateTimestamp.equals(BigInt.fromI32(0)) || 
      wallet.lastDepositUpdateTimestamp.equals(timestamp)) {
    wallet.lastUpdateTimestamp = timestamp;
    wallet.lastDepositUpdateTimestamp = timestamp;
    return;
  }

  // Calculate time difference in seconds
  let timeDiff = timestamp.minus(wallet.lastDepositUpdateTimestamp);
  
  // Skip if time difference is zero or negative
  if (timeDiff.le(BigInt.fromI32(0))) {
    wallet.lastUpdateTimestamp = timestamp;
    wallet.lastDepositUpdateTimestamp = timestamp;
    return;
  }
  
  // Convert to daily basis by dividing by seconds in a day (86400)
  let secondsInDay = BigInt.fromI32(86400);
  
  // Calculate the fraction with precision (multiply by 10^18 for decimal precision)
  let precision = BigInt.fromI32(10).pow(18);
  let dailyFraction = timeDiff.times(precision).div(secondsInDay);
  
  // Add to accumulator with precision adjustment
  let accumulatorAddition = wallet.estimateDeposit.times(dailyFraction).div(precision);
  wallet.coinTimeAccumulator = wallet.coinTimeAccumulator.plus(accumulatorAddition);
  
  // Log for debugging
  log.debug(
    "Updating accumulator: address={}, timeDiff={}, estimateDeposit={}, addition={}, newTotal={}", 
    [
      wallet.id,
      timeDiff.toString(),
      wallet.estimateDeposit.toString(),
      accumulatorAddition.toString(),
      wallet.coinTimeAccumulator.toString()
    ]
  );
  
  // Update timestamps
  wallet.lastUpdateTimestamp = timestamp;
  wallet.lastDepositUpdateTimestamp = timestamp;
}

export function createUserStateSnapshot(wallet: Wallet, timestamp: BigInt, blockNumber: BigInt, txHash: Bytes): void {
  let snapshotId = wallet.id + "-" + timestamp.toString();
  let userState = new UserState(Bytes.fromUTF8(snapshotId));
  
  userState.user = wallet.id;
  userState.balance = wallet.balance;
  userState.estimateDeposit = wallet.estimateDeposit;
  userState.coinTimeAccumulator = wallet.coinTimeAccumulator;
  userState.timestamp = timestamp;
  userState.blockNumber = blockNumber;
  userState.transactionHash = txHash;
  
  userState.save();
} 