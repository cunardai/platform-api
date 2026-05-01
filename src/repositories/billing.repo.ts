import { getPool } from '../config/postgres'
import { PLAN_LIMITS } from '../config'

export interface TenantSubscription {
  id: string
  org_id: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  plan: string
  status: string
  mcp_limit: number
  api_calls_limit: number
  current_period_end: Date | null
  created_at: Date
  updated_at: Date
}

export async function getOrCreateTenant(org_id: string): Promise<TenantSubscription> {
  const { rows } = await getPool().query<TenantSubscription>(
    `INSERT INTO tenant_subscriptions (org_id) VALUES ($1)
     ON CONFLICT (org_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [org_id],
  )
  return rows[0]
}

export async function getTenant(org_id: string): Promise<TenantSubscription | null> {
  const { rows } = await getPool().query<TenantSubscription>(
    `SELECT * FROM tenant_subscriptions WHERE org_id = $1`, [org_id],
  )
  return rows[0] ?? null
}

export async function updateTenantFromStripe(opts: {
  org_id?: string
  stripe_customer_id: string
  stripe_subscription_id: string
  plan: string
  status: string
  current_period_end: Date
}): Promise<void> {
  const limits = PLAN_LIMITS[opts.plan] ?? PLAN_LIMITS.free
  await getPool().query(
    `UPDATE tenant_subscriptions
     SET stripe_subscription_id = $1, plan = $2, status = $3,
         mcp_limit = $4, api_calls_limit = $5, current_period_end = $6, updated_at = NOW()
     WHERE stripe_customer_id = $7`,
    [opts.stripe_subscription_id, opts.plan, opts.status,
     limits.mcp_limit, limits.api_calls_limit, opts.current_period_end, opts.stripe_customer_id],
  )
}

export async function setStripeCustomer(org_id: string, stripe_customer_id: string): Promise<void> {
  await getPool().query(
    `UPDATE tenant_subscriptions SET stripe_customer_id = $1, updated_at = NOW() WHERE org_id = $2`,
    [stripe_customer_id, org_id],
  )
}

export async function recordUsage(org_id: string, event_type: string, meta?: object): Promise<void> {
  await getPool().query(
    `INSERT INTO usage_events (org_id, event_type, meta) VALUES ($1, $2, $3)`,
    [org_id, event_type, meta ? JSON.stringify(meta) : null],
  )
}

export async function getUsageCounts(org_id: string): Promise<Record<string, number>> {
  const { rows } = await getPool().query<{ event_type: string; count: string }>(
    `SELECT event_type, COUNT(*) as count FROM usage_events WHERE org_id = $1 GROUP BY event_type`,
    [org_id],
  )
  return Object.fromEntries(rows.map(r => [r.event_type, parseInt(r.count, 10)]))
}
