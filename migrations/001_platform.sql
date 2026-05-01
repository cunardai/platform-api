-- Platform API schema

-- MCP (Model Context Protocol) registry
CREATE TABLE IF NOT EXISTS mcps (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       TEXT        NOT NULL,
  name         TEXT        NOT NULL,
  slug         TEXT        UNIQUE NOT NULL,
  description  TEXT,
  homepage_url TEXT,
  tags         TEXT[]      NOT NULL DEFAULT '{}',
  is_public    BOOLEAN     NOT NULL DEFAULT true,
  is_verified  BOOLEAN     NOT NULL DEFAULT false,
  created_by   TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mcps_org      ON mcps(org_id);
CREATE INDEX IF NOT EXISTS idx_mcps_public   ON mcps(is_public) WHERE is_public = true;

CREATE TABLE IF NOT EXISTS mcp_versions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mcp_id       UUID        NOT NULL REFERENCES mcps(id) ON DELETE CASCADE,
  version      TEXT        NOT NULL,
  endpoint_url TEXT        NOT NULL,
  schema_url   TEXT,
  changelog    TEXT,
  is_latest    BOOLEAN     NOT NULL DEFAULT false,
  published_by TEXT        NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(mcp_id, version)
);

CREATE INDEX IF NOT EXISTS idx_mcp_versions_mcp ON mcp_versions(mcp_id);

-- Tenant billing state (synced from Stripe webhooks)
CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 TEXT        UNIQUE NOT NULL,
  stripe_customer_id     TEXT        UNIQUE,
  stripe_subscription_id TEXT,
  plan                   TEXT        NOT NULL DEFAULT 'free',
  status                 TEXT        NOT NULL DEFAULT 'active',
  mcp_limit              INTEGER     NOT NULL DEFAULT 3,
  api_calls_limit        INTEGER     NOT NULL DEFAULT 10000,
  current_period_end     TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Usage metering
CREATE TABLE IF NOT EXISTS usage_events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT        NOT NULL,
  event_type TEXT        NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_org_type ON usage_events(org_id, event_type);
CREATE INDEX IF NOT EXISTS idx_usage_created  ON usage_events(created_at);
