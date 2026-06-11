import { getPool } from '../config/postgres'

const DEFAULT_CREDIT_RATES: Record<string, number> = {
  mcp_invoke: 1,
  api_call:   1,
  a2a_task:   10,
  llm_token:  0.001,
}

export interface UsageEvent {
  id: string
  org_id: string
  event_type: string
  quantity: number
  resource_id: string | null
  caller_id: string | null
  credits: string | null
  meta: Record<string, unknown> | null
  created_at: Date
}

export interface TimeseriesDay {
  date: string
  total_credits: number
  total_events: number
  by_type: Record<string, { count: number; quantity: number; credits: number }>
}

export interface UsageSummary {
  total_credits: number
  total_quantity: number
  total_cost_usd: number
  event_count: number
  by_event_type: Record<string, { count: number; quantity: number; credits: number; cost_usd: number }>
}

export async function getUsageTimeseries(opts: {
  org_id: string
  from?: Date
  to?: Date
  days?: number
  resource_id?: string
}): Promise<TimeseriesDay[]> {
  const toDate   = opts.to   ?? new Date()
  const fromDate = opts.from ?? (() => {
    const d = new Date(toDate)
    d.setUTCDate(d.getUTCDate() - ((opts.days ?? 30) - 1))
    return d
  })()

  const MS_PER_DAY = 86_400_000
  const dayCount = Math.min(90, Math.ceil((toDate.getTime() - fromDate.getTime()) / MS_PER_DAY) + 1)

  const conditions: string[] = ['org_id = $1', 'created_at >= $2', 'created_at <= $3']
  const params: unknown[] = [opts.org_id, fromDate, toDate]
  if (opts.resource_id) { params.push(opts.resource_id); conditions.push(`resource_id = $${params.length}`) }

  const where = 'WHERE ' + conditions.join(' AND ')
  const { rows } = await getPool().query<{
    day: Date; event_type: string; count: string; quantity: string; credits: string
  }>(
    `SELECT DATE_TRUNC('day', created_at) as day, event_type,
            COUNT(*) as count, SUM(quantity) as quantity, COALESCE(SUM(credits), 0) as credits
     FROM usage_events ${where}
     GROUP BY day, event_type ORDER BY day ASC`,
    params,
  )

  const dayMap = new Map<string, TimeseriesDay>()
  for (let i = 0; i < dayCount; i++) {
    const d = new Date(fromDate)
    d.setUTCDate(d.getUTCDate() + i)
    const key = d.toISOString().slice(0, 10)
    dayMap.set(key, { date: key, total_credits: 0, total_events: 0, by_type: {} })
  }

  for (const r of rows) {
    const key = new Date(r.day).toISOString().slice(0, 10)
    const entry = dayMap.get(key)
    if (!entry) continue
    const count    = parseInt(r.count, 10)
    const quantity = parseInt(r.quantity, 10)
    const credits  = parseFloat(r.credits)
    entry.by_type[r.event_type] = { count, quantity, credits }
    entry.total_credits += credits
    entry.total_events  += count
  }

  return Array.from(dayMap.values())
}

async function computeCredits(org_id: string, event_type: string, quantity: number, resource_id?: string, client_id?: string): Promise<number> {
  // Client-specific rate takes highest precedence
  if (client_id) {
    const { rows: clientRows } = await getPool().query<{ credit_cost: string }>(
      `SELECT credit_cost FROM event_type_configs WHERE org_id = $1 AND client_id = $2 AND event_type = $3`,
      [org_id, client_id, event_type],
    )
    if (clientRows[0]) return parseFloat(clientRows[0].credit_cost) * quantity
  }

  // Org-wide rate (client_id IS NULL)
  const { rows: cfgRows } = await getPool().query<{ credit_cost: string }>(
    `SELECT credit_cost FROM event_type_configs WHERE org_id = $1 AND client_id IS NULL AND event_type = $2`,
    [org_id, event_type],
  )
  if (cfgRows[0]) return parseFloat(cfgRows[0].credit_cost) * quantity

  // mcp_invoke: look up the MCP's own credit_cost_per_call
  if (event_type === 'mcp_invoke' && resource_id) {
    const { rows } = await getPool().query<{ credit_cost_per_call: number }>(
      `SELECT credit_cost_per_call FROM mcps WHERE slug = $1`,
      [resource_id],
    )
    return (rows[0]?.credit_cost_per_call ?? DEFAULT_CREDIT_RATES.mcp_invoke) * quantity
  }

  return (DEFAULT_CREDIT_RATES[event_type] ?? 0) * quantity
}

export async function recordUsageEvent(opts: {
  org_id: string
  event_type: string
  quantity?: number
  resource_id?: string
  caller_id?: string
  client_id?: string
  meta?: Record<string, unknown>
}): Promise<UsageEvent> {
  const quantity = opts.quantity ?? 1
  const credits = await computeCredits(opts.org_id, opts.event_type, quantity, opts.resource_id, opts.client_id)
  const { rows } = await getPool().query<UsageEvent>(
    `INSERT INTO usage_events (org_id, event_type, quantity, resource_id, caller_id, credits, meta, client_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [opts.org_id, opts.event_type, quantity, opts.resource_id ?? null,
     opts.caller_id ?? null, credits, opts.meta ? JSON.stringify(opts.meta) : null, opts.client_id ?? null],
  )
  return rows[0]
}

export async function listUsageEvents(opts: {
  org_id: string
  resource_id?: string
  from?: Date
  to?: Date
  limit?: number
  offset?: number
}): Promise<{ events: UsageEvent[]; total: number }> {
  const conditions: string[] = ['org_id = $1']
  const params: unknown[] = [opts.org_id]

  if (opts.resource_id) { params.push(opts.resource_id); conditions.push(`resource_id = $${params.length}`) }
  if (opts.from)        { params.push(opts.from);         conditions.push(`created_at >= $${params.length}`) }
  if (opts.to)          { params.push(opts.to);           conditions.push(`created_at <= $${params.length}`) }

  const where = 'WHERE ' + conditions.join(' AND ')

  const { rows: countRows } = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) as count FROM usage_events ${where}`, params,
  )
  const total = parseInt(countRows[0].count, 10)

  params.push(opts.limit ?? 50, opts.offset ?? 0)
  const { rows } = await getPool().query<UsageEvent>(
    `SELECT * FROM usage_events ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return { events: rows, total }
}

export async function getUsageSummary(opts: {
  org_id: string
  resource_id?: string
  from?: Date
  to?: Date
}): Promise<UsageSummary> {
  const conditions: string[] = ['org_id = $1']
  const params: unknown[] = [opts.org_id]

  if (opts.resource_id) { params.push(opts.resource_id); conditions.push(`resource_id = $${params.length}`) }
  if (opts.from)        { params.push(opts.from);         conditions.push(`created_at >= $${params.length}`) }
  if (opts.to)          { params.push(opts.to);           conditions.push(`created_at <= $${params.length}`) }

  const where = 'WHERE ' + conditions.join(' AND ')

  const { rows } = await getPool().query<{
    event_type: string; count: string; quantity: string; credits: string; cost: string
  }>(
    `SELECT event_type, COUNT(*) as count, SUM(quantity) as quantity,
            COALESCE(SUM(credits), 0) as credits, COALESCE(SUM(raw_cost_usd), 0) as cost
     FROM usage_events ${where} GROUP BY event_type`,
    params,
  )

  const by_event_type: UsageSummary['by_event_type'] = {}
  let total_credits = 0
  let total_quantity = 0
  let total_cost_usd = 0
  let event_count = 0

  for (const r of rows) {
    const count    = parseInt(r.count, 10)
    const quantity = parseInt(r.quantity, 10)
    const credits  = parseFloat(r.credits)
    const cost_usd = parseFloat(r.cost)
    by_event_type[r.event_type] = { count, quantity, credits, cost_usd }
    total_credits  += credits
    total_quantity += quantity
    total_cost_usd += cost_usd
    event_count    += count
  }

  return { total_credits, total_quantity, total_cost_usd, event_count, by_event_type }
}

export interface EventTypeConfig {
  id: string
  org_id: string
  client_id: string | null
  client_type: string | null
  event_type: string
  credit_cost: string
  description: string | null
  created_at: Date
  updated_at: Date
}

export async function listEventTypeConfigs(org_id: string, client_id?: string | null): Promise<EventTypeConfig[]> {
  if (client_id != null) {
    // Return configs for this specific client (client_id matches exactly)
    const { rows } = await getPool().query<EventTypeConfig>(
      `SELECT * FROM event_type_configs WHERE org_id = $1 AND client_id = $2 ORDER BY event_type ASC`,
      [org_id, client_id],
    )
    return rows
  }
  // null or undefined → org-wide configs (client_id IS NULL)
  const { rows } = await getPool().query<EventTypeConfig>(
    `SELECT * FROM event_type_configs WHERE org_id = $1 AND client_id IS NULL ORDER BY event_type ASC`,
    [org_id],
  )
  return rows
}

export async function upsertEventTypeConfig(opts: {
  org_id: string
  event_type: string
  credit_cost: number
  description?: string
  client_id?: string | null
  client_type?: string | null
}): Promise<EventTypeConfig> {
  const { rows } = await getPool().query<EventTypeConfig>(
    `INSERT INTO event_type_configs (org_id, event_type, credit_cost, description, client_id, client_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, event_type, (COALESCE(client_id, ''))) DO UPDATE
       SET credit_cost  = EXCLUDED.credit_cost,
           description  = EXCLUDED.description,
           client_type  = EXCLUDED.client_type,
           updated_at   = NOW()
     RETURNING *`,
    [opts.org_id, opts.event_type, opts.credit_cost, opts.description ?? null, opts.client_id ?? null, opts.client_type ?? null],
  )
  return rows[0]
}

export async function deleteEventTypeConfig(org_id: string, event_type: string, client_id?: string | null): Promise<boolean> {
  const { rowCount } = await getPool().query(
    client_id != null
      ? `DELETE FROM event_type_configs WHERE org_id = $1 AND event_type = $2 AND client_id = $3`
      : `DELETE FROM event_type_configs WHERE org_id = $1 AND event_type = $2 AND client_id IS NULL`,
    client_id != null ? [org_id, event_type, client_id] : [org_id, event_type],
  )
  return (rowCount ?? 0) > 0
}
