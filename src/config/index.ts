import dotenv from 'dotenv'
dotenv.config()

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name]
  if (!value && fallback === undefined) throw new Error(`[config] Required env var ${name} is not set.`)
  return value ?? fallback!
}

/** Sentinel meaning "no Stripe credentials supplied". Deliberately carries no
 *  `sk_`/`whsec_` prefix so secret scanners don't flag it as a live key. */
export const STRIPE_UNCONFIGURED = 'stripe-not-configured'

/** Values that are NOT real Stripe credentials. `sk_test_placeholder` is the
 *  historic default and is still present in deployed .env files, so it must
 *  keep counting as "unconfigured" — otherwise billing would try to build a
 *  Stripe client from a dummy key. */
const STRIPE_PLACEHOLDERS: ReadonlySet<string> = new Set([
  STRIPE_UNCONFIGURED,
  'sk_test_placeholder',
  'whsec_placeholder',
])

/** True only when a usable Stripe secret key is configured. */
export function isStripeConfigured(secretKey: string | undefined = undefined): boolean {
  const key = secretKey ?? config.stripe.secretKey
  return !!key && !STRIPE_PLACEHOLDERS.has(key)
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3004', 10),
  auth: {
    issuer:   requireEnv('AUTH_SERVICE_ISSUER',   'http://localhost:3003'),
    jwksUri:  requireEnv('AUTH_SERVICE_JWKS_URI', 'http://localhost:3003/.well-known/jwks.json'),
  },
  stripe: {
    // NOTE: STRIPE_UNCONFIGURED (declared above) is a prefix-free sentinel on
    // purpose — an `sk_test_`/`whsec_` shaped default trips secret scanners on
    // every run, burying real findings under a permanent false positive.
    secretKey:     requireEnv('STRIPE_SECRET_KEY', STRIPE_UNCONFIGURED),
    webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET', STRIPE_UNCONFIGURED),
    prices: {
      starter: process.env.STRIPE_PRICE_STARTER ?? '',
      pro:     process.env.STRIPE_PRICE_PRO ?? '',
    },
  },
  appBaseUrl: requireEnv('APP_BASE_URL', 'http://localhost:3004'),
}

export const PLAN_LIMITS: Record<string, { mcp_limit: number; api_calls_limit: number }> = {
  free:       { mcp_limit: 3,    api_calls_limit: 10_000  },
  starter:    { mcp_limit: 20,   api_calls_limit: 100_000 },
  pro:        { mcp_limit: 100,  api_calls_limit: 1_000_000 },
  enterprise: { mcp_limit: 9999, api_calls_limit: 999_999_999 },
}
