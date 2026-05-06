ALTER TABLE event_type_configs
  ADD COLUMN IF NOT EXISTS client_id   TEXT,
  ADD COLUMN IF NOT EXISTS client_type TEXT;

-- Drop old unique constraint and replace with one that handles nullable client_id
ALTER TABLE event_type_configs DROP CONSTRAINT IF EXISTS event_type_configs_org_id_event_type_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_type_configs_unique
  ON event_type_configs (org_id, event_type, (COALESCE(client_id, '')));

CREATE INDEX IF NOT EXISTS idx_event_type_configs_client ON event_type_configs(org_id, client_id) WHERE client_id IS NOT NULL;

ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS client_id TEXT;
