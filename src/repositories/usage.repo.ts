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

export interface UsageSummary {
  total_credits: number
  total_quantity: number
  event_count: number
  by_event_type: Record<string, { count: number; quantity: number; credits: number }>
}

async function computeCredits(event_type: string, quantity: number, resource_id?: string): Promise<number> {
  let rate: number
  if (event_type === 'mcp_invoke' && resource_id) {
    const { rows } = await getPool().query<{ credit_cost_per_call: number }>(
      `SELECT credit_cost_per_call FROM mcps WHERE slug = $1`,
      [resource_id],
    )
    rate = rows[0]?.credit_cost_per_call ?? DEFAULT_CREDIT_RATES.mcp_invoke
  } else {
    rate = DEFAULT_CREDIT_RATES[event_type] ?? 0
  }
  return rate * quantity
}

export async function recordUsageEvent(opts: {
  org_id: string
  event_type: string
  quantity?: number
  resource_id?: string
  caller_id?: string
  meta?: Record<string, unknown>
}): Promise<UsageEvent> {
  const quantity = opts.quantity ?? 1
  const credits = await computeCredits(opts.event_type, quantity, opts.resource_id)
  const { rows } = await getPool().query<UsageEvent>(
    `INSERT INTO usage_events (org_id, event_type, quantity, resource_id, caller_id, credits, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [opts.org_id, opts.event_type, quantity, opts.resource_id ?? null,
     opts.caller_id ?? null, credits, opts.meta ? JSON.stringify(opts.meta) : null],
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
    event_type: string; count: string; quantity: string; credits: string
  }>(
    `SELECT event_type, COUNT(*) as count, SUM(quantity) as quantity, COALESCE(SUM(credits), 0) as credits
     FROM usage_events ${where} GROUP BY event_type`,
    params,
  )

  const by_event_type: UsageSummary['by_event_type'] = {}
  let total_credits = 0
  let total_quantity = 0
  let event_count = 0

  for (const r of rows) {
    const count    = parseInt(r.count, 10)
    const quantity = parseInt(r.quantity, 10)
    const credits  = parseFloat(r.credits)
    by_event_type[r.event_type] = { count, quantity, credits }
    total_credits  += credits
    total_quantity += quantity
    event_count    += count
  }

  return { total_credits, total_quantity, event_count, by_event_type }
}
