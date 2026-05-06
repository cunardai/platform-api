import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware'
import { recordUsageEvent, listUsageEvents, getUsageSummary, getUsageTimeseries, listEventTypeConfigs, upsertEventTypeConfig, deleteEventTypeConfig, EventTypeConfig } from '../repositories/usage.repo'
import { getOrCreateTenant } from '../repositories/billing.repo'
import { getPool } from '../config/postgres'
import { PLAN_LIMITS } from '../config'

const router = Router()

function orgId(req: Request): string | null {
  return req.caller?.org_id ?? null
}

// ─── POST /usage/events ────────────────────────────────────────────────────────
// Any authenticated caller can record usage for their org.

router.post('/events', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })

  const { event_type, quantity, resource_id, client_id, meta } = req.body as {
    event_type?: string
    quantity?: number
    resource_id?: string
    client_id?: string
    meta?: Record<string, unknown>
  }
  if (!event_type || typeof event_type !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'event_type is required' } })
  }
  if (quantity !== undefined && (typeof quantity !== 'number' || quantity < 1 || !Number.isInteger(quantity))) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'quantity must be a positive integer' } })
  }

  const event = await recordUsageEvent({
    org_id:      org,
    event_type,
    quantity:    quantity ?? 1,
    resource_id: resource_id ?? undefined,
    caller_id:   req.caller?.user_id ?? undefined,
    client_id:   client_id ?? undefined,
    meta,
  })
  return res.status(201).json({ success: true, data: { id: event.id, credits: parseFloat(event.credits ?? '0') } })
})

// ─── GET /usage/events ─────────────────────────────────────────────────────────

router.get('/events', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })

  const { resource_id, from, to, limit, offset } = req.query as Record<string, string | undefined>
  const parsedLimit  = Math.min(parseInt(limit  ?? '50', 10), 200)
  const parsedOffset = parseInt(offset ?? '0', 10)

  const { events, total } = await listUsageEvents({
    org_id:      org,
    resource_id: resource_id ?? undefined,
    from:        from   ? new Date(from)  : undefined,
    to:          to     ? new Date(to)    : undefined,
    limit:       parsedLimit,
    offset:      parsedOffset,
  })
  return res.json({ success: true, data: events, meta: { total, limit: parsedLimit, offset: parsedOffset } })
})

// ─── GET /usage/event-types ────────────────────────────────────────────────────
router.get('/event-types', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const clientId = (req.query.client_id as string | undefined) ?? undefined
  let configs: EventTypeConfig[]
  if (clientId === '__all__') {
    const { rows } = await getPool().query<EventTypeConfig>(
      `SELECT * FROM event_type_configs WHERE org_id = $1 ORDER BY client_id NULLS FIRST, event_type ASC`,
      [org],
    )
    configs = rows
  } else {
    configs = await listEventTypeConfigs(org, clientId ?? null)
  }
  return res.json({ success: true, data: configs })
})

// ─── PUT /usage/event-types/:event_type ───────────────────────────────────────
router.put('/event-types/:event_type', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const event_type = req.params.event_type as string
  const { credit_cost, description, client_id, client_type } = req.body as { credit_cost?: number; description?: string; client_id?: string | null; client_type?: string | null }
  if (credit_cost === undefined || typeof credit_cost !== 'number' || credit_cost < 0) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'credit_cost must be a non-negative number' } })
  }
  const config = await upsertEventTypeConfig({ org_id: org, event_type, credit_cost, description, client_id, client_type })
  return res.json({ success: true, data: config })
})

// ─── DELETE /usage/event-types/:event_type ────────────────────────────────────
router.delete('/event-types/:event_type', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const event_type = req.params.event_type as string
  const clientId = (req.query.client_id as string | undefined) ?? null
  const deleted = await deleteEventTypeConfig(org, event_type, clientId)
  if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Event type config not found' } })
  return res.json({ success: true, data: null })
})

// ─── GET /usage/summary ────────────────────────────────────────────────────────

router.get('/summary', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })

  const { resource_id, from, to } = req.query as Record<string, string | undefined>
  const summary = await getUsageSummary({
    org_id:      org,
    resource_id: resource_id ?? undefined,
    from:        from ? new Date(from) : undefined,
    to:          to   ? new Date(to)   : undefined,
  })
  return res.json({ success: true, data: summary })
})

// ─── GET /usage/timeseries ─────────────────────────────────────────────────────

router.get('/timeseries', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })

  const { resource_id, days, from, to } = req.query as Record<string, string | undefined>
  const parsedDays = days ? Math.min(parseInt(days, 10), 90) : undefined
  const fromDate   = from ? new Date(from) : undefined
  const toDate     = to   ? new Date(to)   : undefined

  const data = await getUsageTimeseries({
    org_id: org,
    days: parsedDays,
    from: fromDate,
    to: toDate,
    resource_id: resource_id ?? undefined,
  })
  return res.json({ success: true, data })
})

// ─── GET /usage/quota ──────────────────────────────────────────────────────────
// Returns current-period usage vs plan limits.

router.get('/quota', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })

  const tenant = await getOrCreateTenant(org)
  const limits  = PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free

  // Use current billing period if available, else current calendar month
  let periodStart: Date
  let periodEnd: Date
  if (tenant.current_period_end) {
    periodEnd   = tenant.current_period_end
    periodStart = new Date(periodEnd)
    periodStart.setMonth(periodStart.getMonth() - 1)
  } else {
    const now = new Date()
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1)
    periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999)
  }

  const summary = await getUsageSummary({ org_id: org, from: periodStart, to: periodEnd })
  const apiCallsUsed = (summary.by_event_type['api_call']?.count ?? 0)

  return res.json({
    success: true,
    data: {
      plan:   tenant.plan,
      period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
      api_calls: {
        used:  apiCallsUsed,
        limit: limits.api_calls_limit,
        pct:   limits.api_calls_limit > 0 ? Math.round((apiCallsUsed / limits.api_calls_limit) * 100) : 0,
      },
      credits: {
        used:  summary.total_credits,
      },
    },
  })
})

export default router
