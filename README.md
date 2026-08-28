# platform-api

REST API for the Cunard Platform — MCP registry and Stripe billing. Deployed on Vercel.

**Production:** `https://platform-api-roan.vercel.app`

---

## What it does

- **MCP registry** — publish, browse, and version Model Context Protocol servers
- **Billing** — Stripe-backed subscription plans (free / starter / pro / enterprise) with usage metering
- **Auth** — validates API keys issued by `auth-service` (RS256 JWT via JWKS, or raw `sk_live_` keys checked against shared Neon DB)

---

## Plans

| Plan       | MCPs | API calls/mo | Price     |
|------------|------|--------------|-----------|
| Free       | 3    | 10,000       | $0        |
| Starter    | 20   | 100,000      | $29/mo    |
| Pro        | 100  | 1,000,000    | $99/mo    |
| Enterprise | ∞    | ∞            | Contact   |

---

## API reference

All authenticated endpoints require one of:
- `Authorization: Bearer <jwt>` — access token from auth-service
- `X-Api-Key: sk_live_<key>` — API key issued via `POST /api-keys` on auth-service

### MCP registry

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/mcps` | — | Browse public MCPs. Query: `?org=<org_id>&limit=50&offset=0` |
| `GET` | `/mcps/:idOrSlug` | — | Get MCP + all versions |
| `POST` | `/mcps` | ✓ | Register a new MCP |
| `PATCH` | `/mcps/:id` | ✓ | Update MCP metadata |
| `DELETE` | `/mcps/:id` | ✓ | Delete an MCP |
| `POST` | `/mcps/:id/versions` | ✓ | Publish a new version |
| `GET` | `/mcps/:id/versions` | — | List versions |

**POST /mcps body:**
```json
{
  "name": "my-mcp",
  "description": "What it does",
  "homepage_url": "https://example.com",
  "tags": ["ai", "search"],
  "is_public": true
}
```

**POST /mcps/:id/versions body:**
```json
{
  "version": "1.0.0",
  "endpoint_url": "https://my-mcp.example.com/mcp",
  "schema_url": "https://my-mcp.example.com/schema.json",
  "changelog": "Initial release"
}
```

### Billing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/billing/plans` | — | List all plans with limits and Stripe price IDs |
| `GET` | `/billing/subscription` | ✓ | Current org plan, usage, and limits |
| `POST` | `/billing/checkout` | ✓ | Create Stripe checkout session |
| `POST` | `/billing/portal` | ✓ | Create Stripe billing portal session |
| `POST` | `/billing/webhook` | Stripe sig | Stripe webhook receiver |

**POST /billing/checkout body:**
```json
{
  "plan": "starter",
  "success_url": "https://yourapp.com/billing?success=1",
  "cancel_url": "https://yourapp.com/billing"
}
```

---

## Local development

```bash
cp .env.example .env
# fill in DATABASE_URL, AUTH_SERVICE_JWKS_URI, STRIPE_* vars

npm install
npm run dev      # tsx watch on port 3004
```

Run the migration against your Neon DB:
```bash
psql $DATABASE_URL -f migrations/001_platform.sql
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✓ | Neon Postgres connection string (shared with auth-service) |
| `AUTH_SERVICE_ISSUER` | ✓ | Base URL of auth-service (e.g. `https://auth-service-jet-seven.vercel.app`) |
| `AUTH_SERVICE_JWKS_URI` | ✓ | JWKS endpoint for RS256 verification |
| `STRIPE_SECRET_KEY` | ✓ | Stripe secret key (`sk_live_` or `sk_test_`) |
| `STRIPE_WEBHOOK_SECRET` | ✓ | Stripe webhook signing secret (`whsec_`) |
| `STRIPE_PRICE_STARTER` | — | Stripe price ID for the Starter plan |
| `STRIPE_PRICE_PRO` | — | Stripe price ID for the Pro plan |
| `APP_BASE_URL` | — | Base URL for portal return redirects |
| `NODE_ENV` | — | `development` or `production` |
| `PORT` | — | Local port (default `3004`) |

---

## Deployment

The project deploys to Vercel via `vercel --prod`. The `vercel.json` routes all traffic through `api/index.ts`.

```bash
vercel --prod
```

Stripe webhook endpoint to register in the Stripe dashboard:
```
https://platform-api-roan.vercel.app/billing/webhook
```

Events to enable: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`

---

## Project structure

```
api/
  index.ts              # Vercel entrypoint (lazy init)
src/
  app.ts                # Express app setup (cors, helmet, routes)
  config/
    index.ts            # Config + PLAN_LIMITS
    postgres.ts         # Neon pool (lazy singleton)
  middleware/
    auth.middleware.ts  # JWT (RS256/JWKS) + API key validation
  repositories/
    mcp.repo.ts         # CRUD + version publishing (atomic tx)
    billing.repo.ts     # Tenant provisioning, Stripe sync, usage events
  routes/
    mcp.routes.ts       # /mcps
    billing.routes.ts   # /billing
migrations/
  001_platform.sql      # mcps, mcp_versions, tenant_subscriptions, usage_events
```

---

## Auth integration

API keys are issued by `auth-service` (`POST /api-keys`). Each key is scoped to the issuing org. The platform-api validates them by looking up the SHA-256 hash in the shared Neon `api_keys` table — no cross-service HTTP call needed.

JWT bearer tokens are validated offline using the JWKS endpoint (`AUTH_SERVICE_JWKS_URI`). The JWKS client caches keys for 10 minutes.


API keys are issued by the auth-service (separate repo at /Users/refat/Documents/Code/2026/auth-service/). To create one:
curl -X POST https://auth-service-jet-seven.vercel.app/api-keys \
  -H "Authorization: Bearer <your-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-key", "scopes": ["usage:write"], "expires_in_days": 365}'
The response includes the raw key (sk_live_...). You use it with the platform-api via the X-Api-Key header:
curl -H "X-Api-Key: sk_live_<key>" https://platform-api-roan.vercel.app/usage/events
The platform-api validates it by SHA-256 hash lookup in the shared Neon api_keys table — no cross-service call needed
