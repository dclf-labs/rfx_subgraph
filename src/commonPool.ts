import { BigInt, ethereum, Bytes, Address } from "@graphprotocol/graph-ts";
import { 
  Transfer as TransferEvent, 
  Approval as ApprovalEvent,
  Deposit as DepositEvent,
  Withdraw as WithdrawEvent,
  RedeemRequest as RedeemRequestEvent,
  FulfilledRedeemRequests as FulfilledRedeemRequestsEvent,
  RecalculatedNAV as RecalculatedNAVEvent
} from "../generated/commonPool/CommonPool";
import { 
  Transfer, 
  Approval,
  Wallet, 
  ProtocolMetrics,
  Deposit,
  Withdrawal,
  RedeemRequest,
  AssetBalance,
  NAVUpdate,
  UserState
} from "../generated/schema";

// Helper functions
function getOrCreateWallet(address: string): Wallet {
  let wallet = Wallet.load(address);
  
  if (wallet == null) {
    wallet = new Wallet(address);
    wallet.balance = BigInt.fromI32(0);
    wallet.shares = BigInt.fromI32(0);
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
function updateWalletBalanceAndAccumulator(wallet: Wallet, newBalance: BigInt, timestamp: BigInt): void {
  // Update coin-time accumulator
  let timeDiff = timestamp.minus(wallet.lastDepositUpdateTimestamp);
  
  // Convert to daily basis by dividing by seconds in a day (86400)
  let secondsInDay = BigInt.fromI32(86400);
  let dailyFraction = timeDiff.div(secondsInDay);
  
  // If time difference is less than a day, we'll use the fraction of a day
  if (timeDiff.lt(secondsInDay) && !timeDiff.isZero()) {
    // Calculate the fraction with precision (multiply by 10^18 for decimal precision)
    let precision = BigInt.fromI32(10).pow(18);
    dailyFraction = timeDiff.times(precision).div(secondsInDay);
    
    // Add to accumulator with precision adjustment
    wallet.coinTimeAccumulator = wallet.coinTimeAccumulator.plus(
      wallet.estimateDeposit.times(dailyFraction).div(precision)
    );
  } else {
    // For time differences of a day or more, use the whole number of days
    wallet.coinTimeAccumulator = wallet.coinTimeAccumulator.plus(
      wallet.estimateDeposit.times(dailyFraction)
    );
  }
  
  // Update timestamps
  wallet.lastUpdateTimestamp = timestamp;
  wallet.lastDepositUpdateTimestamp = timestamp;
}

// Create a snapshot of user state
function createUserStateSnapshot(wallet: Wallet, timestamp: BigInt, blockNumber: BigInt, txHash: Bytes): void {
  let snapshotId = wallet.id + "-" + timestamp.toString();
  let userState = new UserState(Bytes.fromUTF8(snapshotId));
  
  userState.user = wallet.id;
  userState.balance = wallet.balance;
  userState.shares = wallet.shares;
  userState.estimateDeposit = wallet.estimateDeposit;
  userState.coinTimeAccumulator = wallet.coinTimeAccumulator;
  userState.timestamp = timestamp;
  userState.blockNumber = blockNumber;
  userState.transactionHash = txHash;
  
  userState.save();
}

function getOrCreateProtocolMetrics(): ProtocolMetrics {
  let metrics = ProtocolMetrics.load("1");
  
  if (metrics == null) {
    metrics = new ProtocolMetrics("1");
    metrics.totalSupply = BigInt.fromI32(0);
    metrics.totalShares = BigInt.fromI32(0);
    metrics.holderCount = BigInt.fromI32(0);
    metrics.transactionCount = BigInt.fromI32(0);
    metrics.depositCount = BigInt.fromI32(0);
    metrics.withdrawalCount = BigInt.fromI32(0);
    metrics.redeemRequestCount = BigInt.fromI32(0);
    metrics.currentNAV = BigInt.fromI32(0);
    metrics.navEquivalentAsset = Bytes.fromHexString("0x0000000000000000000000000000000000000000");
    metrics.shareToAssetPrice = BigInt.fromI32(0);
    metrics.lastUpdateTimestamp = BigInt.fromI32(0);
    metrics.save();
  }
  
  return metrics;
}

function getOrCreateAssetBalance(assetAddress: Address): AssetBalance {
  let assetId = assetAddress.toHexString();
  let assetBalance = AssetBalance.load(assetId);
  
  if (assetBalance == null) {
    assetBalance = new AssetBalance(assetId);
    let metrics = getOrCreateProtocolMetrics();
    assetBalance.protocol = metrics.id;
    assetBalance.assetAddress = assetAddress;
    assetBalance.balance = BigInt.fromI32(0);
    assetBalance.lastUpdateTimestamp = BigInt.fromI32(0);
    assetBalance.save();
  }
  
  return assetBalance;
}

function getCurrentSharePrice(): BigInt {
  let metrics = getOrCreateProtocolMetrics();
  return metrics.shareToAssetPrice;
}

// Event handlers
export function handleTransfer(event: TransferEvent): void {
  let fromAddress = event.params.from.toHexString();
  let toAddress = event.params.to.toHexString();
  
  let fromWallet = getOrCreateWallet(fromAddress);
  let toWallet = getOrCreateWallet(toAddress);
  let metrics = getOrCreateProtocolMetrics();
  let depositToTransfer = BigInt.fromI32(0);
  // Update balances, shares, and deposit estimates
  if (fromAddress != "0x0000000000000000000000000000000000000000") {
    // Calculate the ratio of tokens being transferred
    let transferRatio = BigInt.fromI32(0);
    if (!fromWallet.balance.isZero()) {
      transferRatio = event.params.amount.times(BigInt.fromI32(10).pow(18)).div(fromWallet.balance);
    }
    
    // Update coin-time accumulator before changing balance
    updateWalletBalanceAndAccumulator(fromWallet, fromWallet.balance, event.block.timestamp);
    
    // Ensure we don't go below zero
    if (fromWallet.balance.ge(event.params.amount)) {
      fromWallet.balance = fromWallet.balance.minus(event.params.amount);
      fromWallet.shares = fromWallet.balance; // Ensure shares = balance
      
      // Transfer proportional amount of estimated deposit
      depositToTransfer = fromWallet.estimateDeposit.times(transferRatio).div(BigInt.fromI32(10).pow(18));
      fromWallet.estimateDeposit = fromWallet.estimateDeposit.minus(depositToTransfer);
    } else {
      fromWallet.balance = BigInt.fromI32(0);
      fromWallet.shares = BigInt.fromI32(0);
      fromWallet.estimateDeposit = BigInt.fromI32(0);
    }
    
    fromWallet.transactionCount = fromWallet.transactionCount.plus(BigInt.fromI32(1));
    fromWallet.save();
    
    // Create a snapshot of the sender's state
    createUserStateSnapshot(fromWallet, event.block.timestamp, event.block.number, event.transaction.hash);
    
    // Update holder count if wallet balance is now zero
    if (fromWallet.balance.equals(BigInt.fromI32(0)) && !fromAddress.includes("0x0000000000000000000000000000000000000")) {
      metrics.holderCount = metrics.holderCount.minus(BigInt.fromI32(1));
    }
  }
  
  if (toAddress != "0x0000000000000000000000000000000000000000") {
    // Update coin-time accumulator before changing balance
    updateWalletBalanceAndAccumulator(toWallet, toWallet.balance, event.block.timestamp);
    
    // Check if this is a new holder
    let isNewHolder = toWallet.balance.equals(BigInt.fromI32(0)) && !toAddress.includes("0x0000000000000000000000000000000000000");
    
    // Calculate deposit estimate to transfer
    if (fromAddress != "0x0000000000000000000000000000000000000000") {
      // If this is a transfer (not a mint), transfer the deposit estimate proportionally
      let fromWallet = getOrCreateWallet(fromAddress);
      
      toWallet.estimateDeposit = toWallet.estimateDeposit.plus(depositToTransfer);
    } 
    
    toWallet.balance = toWallet.balance.plus(event.params.amount);
    toWallet.shares = toWallet.balance; // Ensure shares = balance

    toWallet.transactionCount = toWallet.transactionCount.plus(BigInt.fromI32(1));
    toWallet.save();
    
    // Create a snapshot of the receiver's state
    createUserStateSnapshot(toWallet, event.block.timestamp, event.block.number, event.transaction.hash);
    
    // Update holder count if this is a new holder
    if (isNewHolder) {
      metrics.holderCount = metrics.holderCount.plus(BigInt.fromI32(1));
    }
  }
  
  // Check if this is a burn transaction (transfer to zero address)
  if (toAddress == "0x0000000000000000000000000000000000000000" && 
      fromAddress != "0x0000000000000000000000000000000000000000") {
    // This is a burn transaction - could be related to a redeem request fulfillment
    
    // We'll create a record of this burn
    let burnId = event.transaction.hash.concatI32(event.logIndex.toI32());
    let burn = new Transfer(burnId);
    burn.from = fromAddress;
    burn.to = toAddress;
    burn.amount = event.params.amount;
    burn.blockNumber = event.block.number;
    burn.blockTimestamp = event.block.timestamp;
    burn.transactionHash = event.transaction.hash;
    burn.sharePrice = getCurrentSharePrice();
    burn.save();
  }
  
  // Create transfer entity
  let transfer = new Transfer(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  transfer.from = fromAddress;
  transfer.to = toAddress;
  transfer.amount = event.params.amount;
  transfer.blockNumber = event.block.number;
  transfer.blockTimestamp = event.block.timestamp;
  transfer.transactionHash = event.transaction.hash;
  transfer.sharePrice = getCurrentSharePrice();
  transfer.save();
  
  // Update protocol metrics
  metrics.transactionCount = metrics.transactionCount.plus(BigInt.fromI32(1));
  
  // Update total supply if minting or burning
  if (fromAddress == "0x0000000000000000000000000000000000000000") {
    metrics.totalSupply = metrics.totalSupply.plus(event.params.amount);
    metrics.totalShares = metrics.totalShares.plus(event.params.amount);
  } else if (toAddress == "0x0000000000000000000000000000000000000000") {
    metrics.totalSupply = metrics.totalSupply.minus(event.params.amount);
    metrics.totalShares = metrics.totalShares.minus(event.params.amount);
  }
  
  metrics.lastUpdateTimestamp = event.block.timestamp;
  metrics.save();
}

export function handleApproval(event: ApprovalEvent): void {
  let ownerAddress = event.params.owner.toHexString();
  let owner = getOrCreateWallet(ownerAddress);
  
  let approval = new Approval(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  approval.owner = ownerAddress;
  approval.spender = event.params.spender;
  approval.amount = event.params.amount;
  approval.blockNumber = event.block.number;
  approval.blockTimestamp = event.block.timestamp;
  approval.transactionHash = event.transaction.hash;
  approval.save();
}

export function handleDeposit(event: DepositEvent): void {
  let userAddress = event.params.owner.toHexString();
  let user = getOrCreateWallet(userAddress);
  let metrics = getOrCreateProtocolMetrics();
  
  // Update user's deposit estimate and accumulator
  updateWalletBalanceAndAccumulator(user, user.balance, event.block.timestamp);
  
  // For deposits, we add the full asset amount to the estimate
  user.estimateDeposit = user.estimateDeposit.plus(event.params.assets);
  user.save();
  
  // Create a snapshot of the user's state after deposit
  createUserStateSnapshot(user, event.block.timestamp, event.block.number, event.transaction.hash);
  
  // Create deposit entity
  let deposit = new Deposit(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  deposit.user = userAddress;
  deposit.tokenAmount = event.params.assets;
  deposit.sharesReceived = event.params.shares;
  
  // Since we can't access the contract directly, we'll use a default asset address
  let defaultAsset = Address.fromString("0x0000000000000000000000000000000000000000");
  deposit.asset = defaultAsset;
  deposit.assetAmount = event.params.assets;
  deposit.sharePrice = getCurrentSharePrice();
  deposit.blockNumber = event.block.number;
  deposit.blockTimestamp = event.block.timestamp;
  deposit.transactionHash = event.transaction.hash;
  deposit.save();
  
  // Update asset balance
  let assetBalance = getOrCreateAssetBalance(defaultAsset);
  assetBalance.balance = assetBalance.balance.plus(event.params.assets);
  assetBalance.lastUpdateTimestamp = event.block.timestamp;
  assetBalance.save();
  
  // Update protocol metrics
  metrics.depositCount = metrics.depositCount.plus(BigInt.fromI32(1));
  metrics.lastUpdateTimestamp = event.block.timestamp;
  metrics.save();
}

export function handleWithdraw(event: WithdrawEvent): void {
  let userAddress = event.params.owner.toHexString();
  let user = getOrCreateWallet(userAddress);
  let metrics = getOrCreateProtocolMetrics();
  
  // Create withdrawal entity
  let withdrawal = new Withdrawal(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  withdrawal.user = userAddress;
  withdrawal.tokenAmount = event.params.assets;
  withdrawal.sharesBurned = event.params.shares;
  
  // Since we can't access the contract directly, we'll use a default asset address
  let defaultAsset = Address.fromString("0x0000000000000000000000000000000000000000");
  withdrawal.asset = defaultAsset;
  withdrawal.assetAmount = event.params.assets;
  withdrawal.sharePrice = getCurrentSharePrice();
  withdrawal.blockNumber = event.block.number;
  withdrawal.blockTimestamp = event.block.timestamp;
  withdrawal.transactionHash = event.transaction.hash;
  withdrawal.save();
  
  // Update asset balance
  let assetBalance = getOrCreateAssetBalance(defaultAsset);
  assetBalance.balance = assetBalance.balance.minus(event.params.assets);
  assetBalance.lastUpdateTimestamp = event.block.timestamp;
  assetBalance.save();
  
  // Update protocol metrics
  metrics.withdrawalCount = metrics.withdrawalCount.plus(BigInt.fromI32(1));
  metrics.lastUpdateTimestamp = event.block.timestamp;
  metrics.save();
}

export function handleRedeemRequest(event: RedeemRequestEvent): void {
  let userAddress = event.params.owner.toHexString();
  let user = getOrCreateWallet(userAddress);
  let metrics = getOrCreateProtocolMetrics();
  
  // Create a unique ID for this redeem request using transaction hash + log index
  let redeemRequestId = event.transaction.hash.concatI32(event.logIndex.toI32());
  let redeemRequest = new RedeemRequest(redeemRequestId);
  
  redeemRequest.user = userAddress;
  redeemRequest.shares = event.params.shares;
  
  // Calculate expected assets based on current share price
  let sharePrice = getCurrentSharePrice();
  let expectedAssets = event.params.shares.times(sharePrice).div(BigInt.fromI32(10).pow(18));
  
  redeemRequest.assets = expectedAssets;
  redeemRequest.fulfilled = false;
  redeemRequest.sharePrice = sharePrice;
  redeemRequest.timestamp = event.block.timestamp;
  redeemRequest.blockNumber = event.block.number;
  redeemRequest.transactionHash = event.transaction.hash;
  redeemRequest.save();
  
  // Update protocol metrics
  metrics.redeemRequestCount = metrics.redeemRequestCount.plus(BigInt.fromI32(1));
  metrics.lastUpdateTimestamp = event.block.timestamp;
  metrics.save();
}

export function handleFulfilledRedeemRequests(event: FulfilledRedeemRequestsEvent): void {
  let metrics = getOrCreateProtocolMetrics();
  let sharePrice = getCurrentSharePrice();
  
  // Get the total shares and assets being fulfilled
  let sharesRedeemed = event.params.shares;
  let assetsReturned = event.params.assets;
  
  // Create a record of this fulfillment event
  let fulfillmentId = event.transaction.hash.concatI32(event.logIndex.toI32());
  let fulfillment = new NAVUpdate(fulfillmentId);
  fulfillment.protocol = metrics.id;
  fulfillment.navValue = sharesRedeemed;
  fulfillment.shareToAssetPrice = sharePrice;
  fulfillment.navEquivalentAsset = Address.fromString("0x0000000000000000000000000000000000000000");
  fulfillment.timestamp = event.block.timestamp;
  fulfillment.blockNumber = event.block.number;
  fulfillment.transactionHash = event.transaction.hash;
  fulfillment.save();
  
  // Find and update all unfulfilled redeem requests
  // Since we can't query entities in AssemblyScript, we'll use a different approach
  
  // Look for burn transfers in the same transaction
  // These would be transfers to the zero address
  // We can use the transaction hash to find them
  
  // For each burn transfer, find the corresponding redeem request
  // and mark it as fulfilled
  
  // For now, we'll just update the protocol metrics
  metrics.lastUpdateTimestamp = event.block.timestamp;
  metrics.save();
  
  // IMPORTANT: Add this code to directly update redeem requests
  // This is a simplified approach that assumes all redeem requests with matching
  // transaction hashes should be marked as fulfilled
  
  // Get the transaction hash
  let txHash = event.transaction.hash.toHexString();
  
  // Create a special entity to mark this transaction as having fulfilled redeem requests
  let txMarker = new RedeemRequest(Bytes.fromUTF8("fulfilled-tx-" + txHash));
  txMarker.user = "0x0000000000000000000000000000000000000000";
  txMarker.shares = sharesRedeemed;
  txMarker.assets = assetsReturned;
  txMarker.fulfilled = true;
  txMarker.sharePrice = sharePrice;
  txMarker.timestamp = event.block.timestamp;
  txMarker.blockNumber = event.block.number;
  txMarker.transactionHash = event.transaction.hash;
  txMarker.fulfillmentTimestamp = event.block.timestamp;
  txMarker.fulfillmentBlockNumber = event.block.number;
  txMarker.fulfillmentTransactionHash = event.transaction.hash;
  txMarker.fulfillmentSharePrice = sharePrice;
  txMarker.save();
}

export function handleRecalculatedNAV(event: RecalculatedNAVEvent): void {
  let metrics = getOrCreateProtocolMetrics();
  
  // Update protocol metrics with new NAV values
  metrics.currentNAV = event.params.navValue;
  metrics.shareToAssetPrice = event.params.shareToAssetPrice;
  
  // Since we can't access the contract directly, we'll use a default asset address
  let defaultAsset = Address.fromString("0x0000000000000000000000000000000000000000");
  metrics.navEquivalentAsset = defaultAsset;
  
  metrics.lastUpdateTimestamp = event.block.timestamp;
  metrics.save();
  
  // Create NAV update entity
  let navUpdate = new NAVUpdate(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  navUpdate.protocol = metrics.id;
  navUpdate.navValue = event.params.navValue;
  navUpdate.shareToAssetPrice = event.params.shareToAssetPrice;
  navUpdate.navEquivalentAsset = defaultAsset;
  navUpdate.timestamp = event.block.timestamp;
  navUpdate.blockNumber = event.block.number;
  navUpdate.transactionHash = event.transaction.hash;
  navUpdate.save();
} 