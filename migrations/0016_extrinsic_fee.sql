-- Add fee_tao to extrinsics for TransactionPayment.TransactionFeePaid data (#1815)
ALTER TABLE extrinsics ADD COLUMN fee_tao REAL;
