import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware'
import { requireService } from '../middleware/authz'
import { getBalance, grantCredits, chargeCredits } from '../repositories/credits.repo'
import {
  computeCredits, listModelRates, upsertModelRate,
  listPricingConfig, upsertPricingConfig, TokenUsage,
} from '../repositories/pricing.repo'

const router = Router()

function orgId(req: Request): string | null {
  return req.caller?.org_id ?? null
}

function tokensFrom(body: Record<string, unknown>): TokenUsage {
  const num = (v: unknown) => (typeof v === 'number' && v >= 0 ? Math.floor(v) : undefined)
  return {
    input_tokens:          num(body.input_tokens),
    output_tokens:         num(body.output_tokens),
    cache_creation_tokens: num(body.cache_creation_tokens),
    cache_read_tokens:     num(body.cache_read_tokens),
  }
}

// ─── GET /credits/balance ──────────────────────────────────────────────────────
router.get('/balance', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const deployment_id = (req.query.deployment_id as string | undefined) ?? undefined
  const balance = await getBalance(org, deployment_id)
  return res.json({ success: true, data: balance })
})

// ─── POST /credits/grant ───────────────────────────────────────────────────────
// Add credits (allowance refill / top-up). Provisioning a balance turns
// enforcement ON for that scope. A negative amount removes credits.
router.post('/grant', authenticate, requireService, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const { amount, deployment_id } = req.body as { amount?: number; deployment_id?: string }
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'amount must be a number' } })
  }
  const balance = await grantCredits(org, amount, deployment_id ?? undefined)
  return res.json({ success: true, data: balance })
})

// ─── POST /credits/estimate ────────────────────────────────────────────────────
// Pre-flight gate: price an anticipated call and report whether the balance
// covers it. No mutation. Unprovisioned scope → sufficient = true (unenforced).
router.post('/estimate', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const body = req.body as Record<string, unknown>
  const model = body.model as string | undefined
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'model is required' } })
  }
  const deployment_id = (body.deployment_id as string | undefined) ?? undefined
  const cost    = await computeCredits({ org_id: org, deployment_id, model, tokens: tokensFrom(body) })
  const balance = await getBalance(org, deployment_id)
  const sufficient = !balance.provisioned || balance.balance >= cost.credits
  return res.json({ success: true, data: { ...cost, balance: balance.balance, provisioned: balance.provisioned, sufficient } })
})

// ─── POST /credits/charge ──────────────────────────────────────────────────────
// Record an AI usage event with its token breakdown and decrement the balance.
// This is the after-the-call ledger write; gate with /estimate before the call.
router.post('/charge', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const body = req.body as Record<string, unknown>
  const feature = body.feature as string | undefined
  const model   = body.model as string | undefined
  if (!feature || typeof feature !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'feature is required' } })
  }
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'model is required' } })
  }
  const result = await chargeCredits({
    org_id:        org,
    deployment_id: (body.deployment_id as string | undefined) ?? undefined,
    feature,
    model,
    tokens:        tokensFrom(body),
    resource_id:   (body.resource_id as string | undefined) ?? undefined,
    caller_id:     req.caller?.user_id ?? undefined,
    client_id:     (body.client_id as string | undefined) ?? undefined,
    meta:          (body.meta as Record<string, unknown> | undefined) ?? undefined,
  })
  return res.status(201).json({ success: true, data: result })
})

// ─── Model rates (token prices) ────────────────────────────────────────────────
router.get('/model-rates', authenticate, async (_req: Request, res: Response) => {
  return res.json({ success: true, data: await listModelRates() })
})

router.put('/model-rates/:model', authenticate, requireService, async (req: Request, res: Response) => {
  const model = req.params.model as string
  const { input_per_mtok, output_per_mtok, cache_write_multiplier, cache_read_multiplier } = req.body as {
    input_per_mtok?: number; output_per_mtok?: number; cache_write_multiplier?: number; cache_read_multiplier?: number
  }
  if (typeof input_per_mtok !== 'number' || input_per_mtok < 0) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'input_per_mtok must be a non-negative number' } })
  }
  const rate = await upsertModelRate({ model, input_per_mtok, output_per_mtok, cache_write_multiplier, cache_read_multiplier })
  return res.json({ success: true, data: rate })
})

// ─── Pricing config (markup + credit unit) ─────────────────────────────────────
// Cascade: (org, deployment) → (org, —) → global. Set markup = 0 for BYO-LLM.
router.get('/pricing-config', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  return res.json({ success: true, data: await listPricingConfig(org) })
})

router.put('/pricing-config', authenticate, requireService, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'Caller has no org_id' } })
  const { markup, credit_unit_usd, deployment_id, description } = req.body as {
    markup?: number; credit_unit_usd?: number; deployment_id?: string; description?: string
  }
  if (typeof markup !== 'number' || markup < 0) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'markup must be a non-negative number (0 = BYO-LLM)' } })
  }
  if (credit_unit_usd !== undefined && (typeof credit_unit_usd !== 'number' || credit_unit_usd <= 0)) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'credit_unit_usd must be a positive number' } })
  }
  // Scope is always the caller's org; deployment_id optionally narrows it.
  const cfg = await upsertPricingConfig({ org_id: org, deployment_id: deployment_id ?? null, markup, credit_unit_usd, description })
  return res.json({ success: true, data: cfg })
})

export default router
