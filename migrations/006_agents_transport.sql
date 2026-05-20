-- Add transport_type and auth_header to mcp_versions
ALTER TABLE mcp_versions
  ADD COLUMN IF NOT EXISTS transport_type TEXT NOT NULL DEFAULT 'http'
    CHECK (transport_type IN ('http','sse','stdio')),
  ADD COLUMN IF NOT EXISTS auth_header TEXT;

-- Agents registry
CREATE TABLE IF NOT EXISTS agents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL,
  description     TEXT,
  system_prompt   TEXT,
  model           TEXT NOT NULL DEFAULT 'gpt-4o',
  execution_mode  TEXT NOT NULL DEFAULT 'auto' CHECK (execution_mode IN ('auto','step')),
  mcp_ids         TEXT[] NOT NULL DEFAULT '{}',
  is_public       BOOLEAN NOT NULL DEFAULT true,
  credit_cost     INTEGER NOT NULL DEFAULT 0,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(org_id, slug)
);
