-- Extend usage_events with quantity, resource, caller, and auto-computed credits
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS quantity    INTEGER      NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS resource_id TEXT,
  ADD COLUMN IF NOT EXISTS caller_id   TEXT,
  ADD COLUMN IF NOT EXISTS credits     NUMERIC(12,4);

-- Faster queries for per-org time-range scans and per-resource breakdowns
CREATE INDEX IF NOT EXISTS idx_usage_org_created  ON usage_events(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_resource     ON usage_events(org_id, resource_id) WHERE resource_id IS NOT NULL;
