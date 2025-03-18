import { BigInt, Bytes, log, Address } from "@graphprotocol/graph-ts";
import { 
  Transfer as TransferEvent, 
  Approval as ApprovalEvent
} from "../generated/usnToken/Usn";
import { 
  Transfer, 
  Approval,
  Wallet,
  TransactionUSNAmount
} from "../generated/schema";
import { getOrCreateWallet, createUserStateSnapshot, updateWalletBalanceAndAccumulator } from "./helpers";

// Constants
const INTERMEDIARY_ADDRESS = "0x252e8f4869b2ec03a92eef298f986a7b5ce3b71";
const RFX_POOL_ADDRESS = "0x567779fd248a6f5596748510200c00655b3a0e01";

// Event handlers for USN Token
export function handleUsnTransfer(event: TransferEvent): void {
  let fromAddress = event.params.from.toHexString();
  let toAddress = event.params.to.toHexString();
  
  // Create transfer entity
  let transfer = new Transfer(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  transfer.from = fromAddress;
  transfer.to = toAddress;
  transfer.amount = event.params.value;
  transfer.blockNumber = event.block.number;
  transfer.blockTimestamp = event.block.timestamp;
  transfer.transactionHash = event.transaction.hash;
  transfer.sharePrice = BigInt.fromI32(0); // Not applicable for USN
  transfer.save();
  
  // Track transfers to the RFX Pool (from any source)
  if (toAddress == RFX_POOL_ADDRESS) {
    log.info("USN transfer to RFX Pool: from={}, amount={}, tx={}", [
      fromAddress,
      event.params.value.toString(),
      event.transaction.hash.toHexString()
    ]);
    
    // Create or update TransactionUSNAmount entity to track USN amounts by transaction
    let txHash = event.transaction.hash.toHexString();
    let usnAmountEntity = TransactionUSNAmount.load(txHash);
    
    if (usnAmountEntity == null) {
      usnAmountEntity = new TransactionUSNAmount(txHash);
      usnAmountEntity.amount = event.params.value;
      usnAmountEntity.timestamp = event.block.timestamp;
    } else {
      // If multiple USN transfers in the same transaction, sum them up
      usnAmountEntity.amount = usnAmountEntity.amount.plus(event.params.value);
    }
    
    usnAmountEntity.save();
    
    log.info("Tracked USN amount for transaction: tx={}, amount={}", [
      txHash,
      usnAmountEntity.amount.toString()
    ]);
  }
  
  // Handle direct deposits to the RFX Pool (not from intermediary)
  if (toAddress == RFX_POOL_ADDRESS && fromAddress != INTERMEDIARY_ADDRESS) {
    log.info("Direct USN deposit to RFX Pool: from={}, amount={}, tx={}", [
      fromAddress,
      event.params.value.toString(),
      event.transaction.hash.toHexString()
    ]);
    
    // Update the sender's deposit estimate
    let sender = getOrCreateWallet(fromAddress);
    updateWalletBalanceAndAccumulator(sender, event.block.timestamp);
    sender.estimateDeposit = sender.estimateDeposit.plus(event.params.value);
    sender.lastDepositUpdateTimestamp = event.block.timestamp;
    sender.save();
    createUserStateSnapshot(sender, event.block.timestamp, event.block.number, event.transaction.hash);
    
    log.info("Updated deposit estimate for direct sender: address={}, amount={}", [
      fromAddress,
      sender.estimateDeposit.toString()
    ]);
  }
}

export function handleUsnApproval(event: ApprovalEvent): void {
  let ownerAddress = event.params.owner.toHexString();
  let owner = getOrCreateWallet(ownerAddress);
  
  let approval = new Approval(
    event.transaction.hash.concatI32(event.logIndex.toI32())
  );
  approval.owner = ownerAddress;
  approval.spender = event.params.spender;
  approval.amount = event.params.value;
  approval.blockNumber = event.block.number;
  approval.blockTimestamp = event.block.timestamp;
  approval.transactionHash = event.transaction.hash;
  approval.save();
} 