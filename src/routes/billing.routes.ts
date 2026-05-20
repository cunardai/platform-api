import { Router, Request, Response } from 'express'
import Stripe from 'stripe'
import { authenticate } from '../middleware/auth.middleware'
import { config, PLAN_LIMITS } from '../config'
import { getOrCreateTenant, getTenant, setStripeCustomer, updateTenantFromStripe, getUsageCounts } from '../repositories/billing.repo'
import { logger } from '../lib/logger'

const router = Router()
const stripeConfigured = config.stripe.secretKey && config.stripe.secretKey !== 'sk_test_placeholder'
const stripe = stripeConfigured ? new Stripe(config.stripe.secretKey) : null

function orgId(req: Request): string | null {
  return req.caller?.org_id ?? null
}

// ─── GET /billing/subscription ────────────────────────────────────────────────

router.get('/subscription', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const tenant = await getOrCreateTenant(org)
  const usage = await getUsageCounts(org)
  return res.json({ success: true, data: { ...tenant, usage, limits: PLAN_LIMITS[tenant.plan] ?? PLAN_LIMITS.free } })
})

// ─── GET /billing/plans ───────────────────────────────────────────────────────

router.get('/plans', (_req: Request, res: Response) => {
  return res.json({
    success: true,
    data: [
      { id: 'free',     name: 'Free',       price_usd: 0,    ...PLAN_LIMITS.free },
      { id: 'starter',  name: 'Starter',    price_usd: 29,   ...PLAN_LIMITS.starter,  stripe_price: config.stripe.prices.starter },
      { id: 'pro',      name: 'Pro',        price_usd: 99,   ...PLAN_LIMITS.pro,       stripe_price: config.stripe.prices.pro },
      { id: 'enterprise', name: 'Enterprise', price_usd: null, ...PLAN_LIMITS.enterprise },
    ],
  })
})

// ─── POST /billing/checkout ───────────────────────────────────────────────────

router.post('/checkout', authenticate, async (req: Request, res: Response) => {
  if (!stripe) return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Billing is not configured. Contact enterprise@cunardai.com to upgrade.' } })

  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })

  const { plan, success_url, cancel_url } = req.body as { plan?: string; success_url?: string; cancel_url?: string }
  const priceId = plan === 'starter' ? config.stripe.prices.starter : plan === 'pro' ? config.stripe.prices.pro : null
  if (!priceId) return res.status(400).json({ success: false, error: { code: 'INVALID_PLAN', message: 'plan must be starter or pro' } })
  if (!success_url || !cancel_url) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'success_url and cancel_url required' } })

  const tenant = await getOrCreateTenant(org)

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url,
    cancel_url,
    client_reference_id: org,
    ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : {}),
    metadata: { org_id: org },
  })

  return res.json({ success: true, data: { checkout_url: session.url } })
})

// ─── POST /billing/portal ─────────────────────────────────────────────────────

router.post('/portal', authenticate, async (req: Request, res: Response) => {
  if (!stripe) return res.status(503).json({ success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: 'Billing is not configured. Contact enterprise@cunardai.com to upgrade.' } })

  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const tenant = await getTenant(org)
  if (!tenant?.stripe_customer_id) return res.status(400).json({ success: false, error: { code: 'NO_SUBSCRIPTION', message: 'No active subscription found' } })

  const { return_url } = req.body as { return_url?: string }
  const session = await stripe!.billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: return_url ?? config.appBaseUrl,
  })
  return res.json({ success: true, data: { portal_url: session.url } })
})

// ─── POST /billing/webhook — Stripe webhook ────────────────────────────────────

router.post('/webhook', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'] as string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any

  try {
    if (!stripe) return res.status(503).json({ error: 'Billing not configured' })
    event = stripe.webhooks.constructEvent(req.body as Buffer, sig, config.stripe.webhookSecret)
  } catch (err) {
    logger.warn('Stripe webhook signature invalid', { error: String(err) })
    return res.status(400).json({ error: 'Invalid webhook signature' })
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const obj = event.data.object as any
    switch (event.type as string) {
      case 'checkout.session.completed':
        if (obj.customer && obj.client_reference_id) {
          await setStripeCustomer(obj.client_reference_id as string, obj.customer as string)
        }
        break
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        await updateTenantFromStripe({
          stripe_customer_id:     obj.customer as string,
          stripe_subscription_id: obj.id as string,
          plan:   detectPlan(obj),
          status: obj.status as string,
          current_period_end: new Date((obj.current_period_end as number) * 1000),
        })
        break
      case 'customer.subscription.deleted':
        await updateTenantFromStripe({
          stripe_customer_id:     obj.customer as string,
          stripe_subscription_id: obj.id as string,
          plan: 'free',
          status: 'canceled',
          current_period_end: new Date((obj.current_period_end as number) * 1000),
        })
        break
    }
  } catch (err) {
    logger.error('Stripe webhook handler error', { type: event.type as string, error: String(err) })
    return res.status(500).json({ error: 'Webhook handler failed' })
  }

  return res.json({ received: true })
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function detectPlan(sub: any): string {
  const priceId = sub.items?.data?.[0]?.price?.id as string | undefined
  if (priceId === config.stripe.prices.pro)     return 'pro'
  if (priceId === config.stripe.prices.starter) return 'starter'
  return 'free'
}

export default router
