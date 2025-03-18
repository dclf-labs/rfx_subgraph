import { BigInt, ethereum, Bytes, Address, log } from "@graphprotocol/graph-ts";
import { 
  Transfer as TransferEvent
} from "../generated/rfxPool/RfxPool";
import { 
  Transfer, 
  Wallet, 
  UserState,
  TransactionUSNAmount,
  ProcessedTransaction
} from "../generated/schema";
import { getOrCreateWallet, createUserStateSnapshot, updateWalletBalanceAndAccumulator } from "./helpers";

// Constants
const INTERMEDIARY_ADDRESS = "0x252e8f4869b2ec03a92eef298f986a7b5ce3b71";
const RFX_POOL_ADDRESS = "0x567779fd248a6f5596748510200c00655b3a0e01";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USN_TOKEN_ADDRESS = "0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91";
const REDEMPTION_ADDRESS = "0xe62d220def5d1656447289fa001cfc69a8af1fb7";

// Event handlers for RFX Pool
export function handleRfxTransfer(event: TransferEvent): void {
  let fromAddress = event.params.from.toHexString();
  let toAddress = event.params.to.toHexString();
  
  // Get the transfer amount - using value instead of amount
  let transferAmount = event.params.value;
  
  let fromWallet = getOrCreateWallet(fromAddress);
  let toWallet = getOrCreateWallet(toAddress);
  
  let depositToTransfer = BigInt.fromI32(0);
  let txHash = event.transaction.hash.toHexString();
  
  // Handle minting of RP tokens (from zero address)
  if (fromAddress == ZERO_ADDRESS && toAddress != ZERO_ADDRESS) {
    log.info("RP tokens minted to user: address={}, amount={}, tx={}", [
      toAddress,
      transferAmount.toString(),
      txHash
    ]);
    
    // Check if we've already processed this transaction to prevent double counting
    let processedTxKey = txHash + "-deposit";
    let processedTx = ProcessedTransaction.load(processedTxKey);
    
    if (processedTx == null) {
      // Look up the USN amount from the same transaction
      let usnAmountEntity = TransactionUSNAmount.load(txHash);
      
      // Default to zero if no USN transfer found
      let usnAmount = BigInt.fromI32(0);
      
      if (usnAmountEntity != null) {
        // Use the tracked USN amount instead of the full RP amount
        usnAmount = usnAmountEntity.amount;
        log.info("Found USN amount for transaction: tx={}, usn_amount={}", [
          txHash,
          usnAmount.toString()
        ]);
      } else {
        log.warning("No USN transfer found for transaction: tx={}, using default of 0", [
          txHash
        ]);
      }
      
      // Update the user's deposit estimate with the USN amount only
      updateWalletBalanceAndAccumulator(toWallet, event.block.timestamp);
      toWallet.estimateDeposit = toWallet.estimateDeposit.plus(usnAmount);
      toWallet.lastDepositUpdateTimestamp = event.block.timestamp;
      
      log.info("Updated deposit estimate for user: address={}, usn_amount={}", [
        toAddress,
        usnAmount.toString()
      ]);
      
      // Mark this transaction as processed by creating a ProcessedTransaction entity
      processedTx = new ProcessedTransaction(processedTxKey);
      processedTx.transactionHash = event.transaction.hash;
      processedTx.timestamp = event.block.timestamp;
      processedTx.save();
    } else {
      log.info("Skipping duplicate RFX minting in the same transaction: tx={}", [txHash]);
    }
    
    // Always update the balance regardless of deposit handling
    toWallet.balance = toWallet.balance.plus(transferAmount);
    toWallet.transactionCount = toWallet.transactionCount.plus(BigInt.fromI32(1));
    toWallet.save();
    
    // Create a snapshot of the receiver's state
    createUserStateSnapshot(toWallet, event.block.timestamp, event.block.number, event.transaction.hash);
  }
  
  // Handle burning of RP tokens (to zero address)
  else if (fromAddress != ZERO_ADDRESS && toAddress == ZERO_ADDRESS) {
    log.info("RP tokens burned from user: address={}, amount={}, tx={}", [
      fromAddress,
      transferAmount.toString(),
      txHash
    ]);
    
    // Calculate the ratio of tokens being burned
    let burnRatio = BigInt.fromI32(0);
    if (!fromWallet.balance.isZero()) {
      burnRatio = transferAmount.times(BigInt.fromI32(10).pow(18)).div(fromWallet.balance);
    }
    
    // Update coin-time accumulator before changing balance
    updateWalletBalanceAndAccumulator(fromWallet, event.block.timestamp);
    
    // Ensure we don't go below zero
    if (fromWallet.balance.ge(transferAmount)) {
      fromWallet.balance = fromWallet.balance.minus(transferAmount);
      
      // Calculate proportional amount of estimated deposit to reduce
      let depositToReduce = fromWallet.estimateDeposit.times(burnRatio).div(BigInt.fromI32(10).pow(18));
      fromWallet.estimateDeposit = fromWallet.estimateDeposit.minus(depositToReduce);
      
      log.info("Reduced deposit estimate for user: address={}, reduction={}, new_estimate={}", [
        fromAddress,
        depositToReduce.toString(),
        fromWallet.estimateDeposit.toString()
      ]);
    } else {
      fromWallet.balance = BigInt.fromI32(0);
      fromWallet.estimateDeposit = BigInt.fromI32(0);
    }
    
    fromWallet.transactionCount = fromWallet.transactionCount.plus(BigInt.fromI32(1));
    fromWallet.save();
    
    // Create a snapshot of the sender's state
    createUserStateSnapshot(fromWallet, event.block.timestamp, event.block.number, event.transaction.hash);
  }
  
  // Handle redemption of RP tokens (to redemption address)
  else if (fromAddress != ZERO_ADDRESS && toAddress.toLowerCase() == REDEMPTION_ADDRESS) {
    log.info("RP tokens redeemed by user: address={}, amount={}, tx={}", [
      fromAddress,
      transferAmount.toString(),
      txHash
    ]);
    
    // Calculate the ratio of tokens being redeemed
    let redeemRatio = BigInt.fromI32(0);
    if (!fromWallet.balance.isZero()) {
      redeemRatio = transferAmount.times(BigInt.fromI32(10).pow(18)).div(fromWallet.balance);
    }
    
    // Update coin-time accumulator before changing balance
    updateWalletBalanceAndAccumulator(fromWallet, event.block.timestamp);
    
    // Ensure we don't go below zero
    if (fromWallet.balance.ge(transferAmount)) {
      fromWallet.balance = fromWallet.balance.minus(transferAmount);
      
      // Calculate proportional amount of estimated deposit to reduce
      let depositToReduce = fromWallet.estimateDeposit.times(redeemRatio).div(BigInt.fromI32(10).pow(18));
      fromWallet.estimateDeposit = fromWallet.estimateDeposit.minus(depositToReduce);
      
      log.info("Reduced deposit estimate for redeeming user: address={}, reduction={}, new_estimate={}", [
        fromAddress,
        depositToReduce.toString(),
        fromWallet.estimateDeposit.toString()
      ]);
    } else {
      fromWallet.balance = BigInt.fromI32(0);
      fromWallet.estimateDeposit = BigInt.fromI32(0);
    }
    
    // Update the redemption address wallet
    toWallet.balance = toWallet.balance.plus(transferAmount);
    
    // Update transaction counts
    fromWallet.transactionCount = fromWallet.transactionCount.plus(BigInt.fromI32(1));
    toWallet.transactionCount = toWallet.transactionCount.plus(BigInt.fromI32(1));
    
    // Save wallets
    fromWallet.save();
    toWallet.save();
    
    // Create a snapshot of the sender's state
    createUserStateSnapshot(fromWallet, event.block.timestamp, event.block.number, event.transaction.hash);
  }
  
  // Handle regular transfers between users
  else if (fromAddress != ZERO_ADDRESS && toAddress != ZERO_ADDRESS) {
    // Calculate the ratio of tokens being transferred
    let transferRatio = BigInt.fromI32(0);
    if (!fromWallet.balance.isZero()) {
      transferRatio = transferAmount.times(BigInt.fromI32(10).pow(18)).div(fromWallet.balance);
    }
    
    // Update coin-time accumulator before changing balance
    updateWalletBalanceAndAccumulator(fromWallet, event.block.timestamp);
    updateWalletBalanceAndAccumulator(toWallet, event.block.timestamp);
    
    // Ensure we don't go below zero
    if (fromWallet.balance.ge(transferAmount)) {
      fromWallet.balance = fromWallet.balance.minus(transferAmount);
      
      // Calculate proportional amount of estimated deposit to transfer
      depositToTransfer = fromWallet.estimateDeposit.times(transferRatio).div(BigInt.fromI32(10).pow(18));
      fromWallet.estimateDeposit = fromWallet.estimateDeposit.minus(depositToTransfer);
      
      // Update the receiver's deposit estimate
      toWallet.estimateDeposit = toWallet.estimateDeposit.plus(depositToTransfer);
      
      log.info("Transferred deposit estimate: from={}, to={}, amount={}", [
        fromAddress,
        toAddress,
        depositToTransfer.toString()
      ]);
    } else {
      fromWallet.balance = BigInt.fromI32(0);
      fromWallet.estimateDeposit = BigInt.fromI32(0);
    }
    
    // Update balances
    toWallet.balance = toWallet.balance.plus(transferAmount);
    
    // Update transaction counts
    fromWallet.transactionCount = fromWallet.transactionCount.plus(BigInt.fromI32(1));
    toWallet.transactionCount = toWallet.transactionCount.plus(BigInt.fromI32(1));
    
    // Save wallets
    fromWallet.save();
    toWallet.save();
    
    // Create snapshots
    createUserStateSnapshot(fromWallet, event.block.timestamp, event.block.number, event.transaction.hash);
    createUserStateSnapshot(toWallet, event.block.timestamp, event.block.number, event.transaction.hash);
  }
  
  // Create transfer entity
  let transfer = new Transfer(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  transfer.from = fromAddress;
  transfer.to = toAddress;
  transfer.amount = transferAmount;
  transfer.blockNumber = event.block.number;
  transfer.blockTimestamp = event.block.timestamp;
  transfer.transactionHash = event.transaction.hash;
  transfer.sharePrice = BigInt.fromI32(0); // Not using share price
  transfer.save();
} 