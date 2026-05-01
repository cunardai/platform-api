-- Add credit metering to MCPs
ALTER TABLE mcps ADD COLUMN IF NOT EXISTS credit_cost_per_call INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN mcps.credit_cost_per_call IS 'Credits charged per API call (0 = free). 1 credit = $0.001. Platform retains 20%.';
