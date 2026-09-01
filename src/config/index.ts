import dotenv from 'dotenv'
dotenv.config()

function requireEnv(names: string | string[], fallback?: string): string {
  const candidates = Array.isArray(names) ? names : [names]
  for (const name of candidates) {
    const value = process.env[name]
    if (value) return value
  }
  if (fallback === undefined) throw new Error(`[config] Required env var ${candidates.join(' or ')} is not set.`)
  return fallback
}

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3004', 10),
  auth: {
    issuer:   requireEnv('AUTH_SERVICE_ISSUER',   'http://localhost:3003'),
    jwksUri:  requireEnv('AUTH_SERVICE_JWKS_URI', 'http://localhost:3003/.well-known/jwks.json'),
  },
  stripe: {
    secretKey:     requireEnv(['PLATEFORMAPISBSTRIPESECRETKEY', 'STRIPE_SECRET_KEY'], 'sk_test_placeholder'),
    webhookSecret: requireEnv('STRIPE_WEBHOOK_SECRET', 'whsec_placeholder'),
    prices: {
      starter: requireEnv(['PLATEFORMAPISBSTRIPEPRICESTARTER', 'STRIPE_PRICE_STARTER'], ''),
      pro:     requireEnv(['PLATEFORMAPISBSTRIPEPRICEPRO', 'STRIPE_PRICE_PRO'], ''),
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
