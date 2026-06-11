-- 006_token_metering.sql
-- Token-level AI metering: cache-aware token granularity on usage_events,
-- a per-model rate table, a markup/credit-unit config with a
-- deployment → org → global cascade, and a per-(org, deployment) credit balance.
--
-- All additive: existing usage_events rows and the existing recordUsageEvent
-- path keep working (new columns are nullable).

-- ── 1. Token granularity on usage_events ───────────────────────────────────────
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS model                 TEXT,
  ADD COLUMN IF NOT EXISTS deployment_id         TEXT,
  ADD COLUMN IF NOT EXISTS input_tokens          INTEGER,
  ADD COLUMN IF NOT EXISTS output_tokens         INTEGER,
  ADD COLUMN IF NOT EXISTS cache_creation_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS cache_read_tokens     INTEGER,
  ADD COLUMN IF NOT EXISTS raw_cost_usd          NUMERIC(14,6);

CREATE INDEX IF NOT EXISTS idx_usage_events_org_deployment
  ON usage_events (org_id, deployment_id);

-- ── 2. Per-model token rates (USD per 1M tokens) ───────────────────────────────
-- cache_write_multiplier / cache_read_multiplier are applied to the INPUT rate
-- (Anthropic prompt-caching: writes ~1.25×, reads ~0.10×). Configurable per model.
CREATE TABLE IF NOT EXISTS model_rates (
  model                  TEXT          PRIMARY KEY,
  input_per_mtok         NUMERIC(12,4) NOT NULL,
  output_per_mtok        NUMERIC(12,4) NOT NULL DEFAULT 0,
  cache_write_multiplier NUMERIC(6,3)  NOT NULL DEFAULT 1.250,
  cache_read_multiplier  NUMERIC(6,3)  NOT NULL DEFAULT 0.100,
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Seed current model prices (2026-06). Edit via PUT /credits/model-rates/:model.
INSERT INTO model_rates (model, input_per_mtok, output_per_mtok) VALUES
  ('claude-opus-4-8',          5.00, 25.00),
  ('claude-sonnet-4-6',        3.00, 15.00),
  ('claude-haiku-4-5',         1.00,  5.00),
  ('gpt-4o-mini',              0.15,  0.60),
  ('text-embedding-3-small',   0.02,  0.00),
  ('text-embedding-3-large',   0.13,  0.00)
ON CONFLICT (model) DO NOTHING;

-- ── 3. Markup + credit-unit config (deployment → org → global cascade) ─────────
-- credits = ceil(raw_cost_usd * markup / credit_unit_usd).
-- BYO-LLM: set markup = 0 for that org/deployment → credits = 0 (platform fee only).
CREATE TABLE IF NOT EXISTS pricing_config (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          TEXT,                          -- NULL = global default
  deployment_id   TEXT,                          -- NULL = org-wide (or global)
  markup          NUMERIC(8,4)  NOT NULL DEFAULT 1.4000,
  credit_unit_usd NUMERIC(12,6) NOT NULL DEFAULT 0.010000,
  description     TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- One config per (org, deployment) scope; COALESCE so NULLs participate uniquely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pricing_config_scope
  ON pricing_config ((COALESCE(org_id, '')), (COALESCE(deployment_id, '')));

-- Global default: 1.4× markup, 1 credit = $0.01.
INSERT INTO pricing_config (org_id, deployment_id, markup, credit_unit_usd, description)
SELECT NULL, NULL, 1.4000, 0.010000, 'Global default'
WHERE NOT EXISTS (
  SELECT 1 FROM pricing_config WHERE org_id IS NULL AND deployment_id IS NULL
);

-- ── 4. Per-(org, deployment) credit balance ────────────────────────────────────
-- deployment_id '' = the org-level (no-deployment) balance, so the PK is non-null.
-- A missing row means "not provisioned" → unenforced (treated as unlimited);
-- enforcement is opt-in by granting a balance.
CREATE TABLE IF NOT EXISTS credit_balances (
  org_id        TEXT          NOT NULL,
  deployment_id TEXT          NOT NULL DEFAULT '',
  balance       NUMERIC(16,4) NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (org_id, deployment_id)
);
