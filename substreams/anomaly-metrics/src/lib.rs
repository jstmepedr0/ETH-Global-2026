use std::collections::BTreeSet;

use num_bigint::BigUint;
use substreams_ethereum::pb::eth::v2::{Block, TransactionTraceStatus};

substreams_ethereum::init!();

#[derive(Clone, PartialEq, prost::Message)]
pub struct BlockMetrics {
    #[prost(uint64, tag = "1")]
    pub block_number: u64,
    #[prost(string, tag = "2")]
    pub block_hash: String,
    #[prost(int64, tag = "3")]
    pub timestamp: i64,
    #[prost(uint64, tag = "4")]
    pub transaction_count: u64,
    #[prost(uint64, tag = "5")]
    pub failed_transaction_count: u64,
    #[prost(uint64, tag = "6")]
    pub unique_sender_count: u64,
    #[prost(string, tag = "7")]
    pub gas_used: String,
    #[prost(string, tag = "8")]
    pub gas_limit: String,
    #[prost(string, tag = "9")]
    pub total_fees_wei: String,
    #[prost(uint64, tag = "10")]
    pub fee_transaction_count: u64,
    #[prost(string, tag = "11")]
    pub fee_gas_used: String,
}

#[substreams::handlers::map]
pub fn map_block_metrics(block: Block) -> Result<BlockMetrics, substreams::errors::Error> {
    let header = block
        .header
        .ok_or_else(|| substreams::errors::Error::msg("block header is missing"))?;
    let mut senders = BTreeSet::new();
    let mut failed = 0_u64;
    let mut total_fees = BigUint::default();
    let mut fee_transaction_count = 0_u64;
    let mut fee_gas_used = 0_u64;

    for transaction in &block.transaction_traces {
        senders.insert(transaction.from.clone());
        if transaction.status == TransactionTraceStatus::Failed as i32
            || transaction.status == TransactionTraceStatus::Reverted as i32
        {
            failed += 1;
        }
        if let Some(gas_price) = &transaction.gas_price {
            total_fees += BigUint::from_bytes_be(&gas_price.bytes) * transaction.gas_used;
            fee_transaction_count += 1;
            fee_gas_used += transaction.gas_used;
        }
    }

    Ok(BlockMetrics {
        block_number: block.number,
        block_hash: format!("0x{}", hex::encode(block.hash)),
        timestamp: header.timestamp.map(|value| value.seconds).unwrap_or_default(),
        transaction_count: block.transaction_traces.len() as u64,
        failed_transaction_count: failed,
        unique_sender_count: senders.len() as u64,
        gas_used: header.gas_used.to_string(),
        gas_limit: header.gas_limit.to_string(),
        total_fees_wei: total_fees.to_string(),
        fee_transaction_count,
        fee_gas_used: fee_gas_used.to_string(),
    })
}
