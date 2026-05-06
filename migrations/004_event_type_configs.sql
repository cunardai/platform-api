CREATE TABLE IF NOT EXISTS event_type_configs (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       TEXT          NOT NULL,
  event_type   TEXT          NOT NULL,
  credit_cost  NUMERIC(10,4) NOT NULL DEFAULT 1.0000,
  description  TEXT,
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  UNIQUE (org_id, event_type)
);
CREATE INDEX IF NOT EXISTS idx_event_type_configs_org ON event_type_configs(org_id);
