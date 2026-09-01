# Data Masking & Field Encryption — ISO 27001:2022 A.8.11

This service enforces **A.8.11 (Data masking)** with a defence-in-depth stack: encryption at
rest for the single upstream secret, allow-list serializers at the API boundary, and secret
scrubbing in logs. All controls are **additive, configurable, and degrade safely** (they no-op
rather than crash when keys are unset).

## 1. Data classification

| Table | Column | Classification | At rest | Returned to owner | Returned to public / cross-org |
|-------|--------|----------------|---------|-------------------|-------------------------------|
| `mcp_versions` | `auth_header` | **Secret** (upstream credential) | AES-256-GCM (`enc:`) | decrypted plaintext | **stripped (absent)** |
| `agents` | `system_prompt` | Restricted (author IP) | plaintext | full | **stripped (absent)** |
| `tenant_subscriptions` | `stripe_customer_id`, `stripe_subscription_id` | Restricted | plaintext | full | partial mask (last 4) |
| `usage_events` | `caller_id` | Restricted (user id) | plaintext | full | partial mask (last 4) |
| `usage_events` | `meta` | Internal | plaintext | full | deep-masked by key name |
| `api_keys` | `key_hash` | Secret | SHA-256 (never reversible) | never serialized | never serialized |

Policy is declared centrally in [`src/security/masking/config.ts`](../src/security/masking/config.ts).

## 2. Where masking is enforced

| Layer | File | What it does |
|-------|------|--------------|
| Masking primitives (pure, unit-tested) | `src/security/masking/mask.ts` | `redact`, `maskPartial`, `maskEmail`, `hashValue`, `pseudonymize`, `deepMaskObject`, `redactSecretsInString` |
| Encryption at rest | `src/security/crypto.ts` | AES-256-GCM, `enc:` prefix, pass-through when key unset / value already encrypted |
| API-boundary serializers | `src/security/serializers.ts` | owner-vs-public visibility for mcp versions, agents, tenants, usage events |
| Owner detection on public routes | `src/middleware/auth.middleware.ts` → `optionalAuthenticate` | best-effort auth; never rejects; lets a route stay public but reveal owner-only fields to the authenticated owner |
| MCP write path | `src/repositories/mcp.repo.ts` → `publishVersion` | encrypts `auth_header` on insert |
| MCP read paths | `src/routes/mcp.routes.ts` | `GET /mcps/:idOrSlug`, `GET /mcps/:id/versions`, `POST /mcps/:id/versions` serialize versions |
| Agent read paths | `src/routes/agent.routes.ts` | `GET /agents`, `GET /agents/:id` strip `system_prompt` cross-org |
| Billing / usage | `src/routes/billing.routes.ts`, `src/routes/usage.routes.ts` | serialize tenant + usage events |
| Log redaction | `src/lib/logger.ts` | every `meta` deep-masked; message string scrubbed of secrets/emails |
| Access-log IP | `src/app.ts` | `morgan` format drops `:remote-addr` and referrer |

### The critical fix

`auth_header` (a publisher's upstream credential) was previously returned on the **public**
`GET /mcps/:idOrSlug` and `GET /mcps/:id/versions` responses via `SELECT *`. A public marketplace
installer could read another org's secret. It is now **encrypted at rest** and **stripped for
every public / non-owner response**; any AUTHENTICATED caller receives it decrypted (it is the shared marketplace connection token consumers need); anonymous/public callers get it stripped.
Proven by `src/security/serializers.test.ts` (the `CRITICAL:` test).

## 3. Key management

| Key | Env var | Format | If unset |
|-----|---------|--------|----------|
| Field encryption | `PLATEFORMAPISBENCRYPTIONKEY` (preferred, Azure Key Vault-backed) or `ENCRYPTION_KEY` (legacy local/dev fallback) | 64 hex chars (32 bytes) — `openssl rand -hex 32` | encryption disabled, values pass through as plaintext (degradable) |
| Pseudonymisation HMAC | `PLATEFORMAPISBPSEUDONYMKEY` (preferred, Azure Key Vault-backed) or `PSEUDONYM_KEY` (legacy local/dev fallback) | any high-entropy secret | `pseudonymize()` falls back to plain SHA-256 |

- Placeholders are in `.env.example`. Real keys live only in the deployment secret store.
- Decryption failures (wrong key / tampering) return the stored value rather than throwing —
  availability-preserving; rotate the key and re-run the migration to recover.
- Rotation of `ENCRYPTION_KEY` / `PLATEFORMAPISBENCRYPTIONKEY` requires decrypt-with-old /
  re-encrypt-with-new (not yet automated).

## 4. Migration (RUN THIS)

Existing plaintext `auth_header` rows are backfilled by a **non-destructive, idempotent,
dry-run-by-default** migration:

```bash
# 1. Ensure PLATEFORMAPISBENCRYPTIONKEY or ENCRYPTION_KEY (64 hex) is set in the environment.
# 2. Preview (writes nothing):
npm run migrate:encrypt-auth-header
# 3. Apply:
npm run migrate:encrypt-auth-header -- --apply
```

Source: `src/migrations/encrypt-auth-header.ts`. It refuses to run without a valid key, skips rows
already prefixed `enc:`, and never prints secret values.

## 5. A.8.11 control mapping

| Requirement | Implementation |
|-------------|----------------|
| Mask sensitive data on output | serializers strip/partial-mask per classification table |
| Restrict to authorised users | `auth_header` / `system_prompt` returned only to authenticated callers (anonymous/public stripped); stripe/usage stay owner-only |
| Encryption/pseudonymisation techniques | AES-256-GCM at rest; HMAC pseudonymisation; SHA-256 hashing |
| Mask in logs & telemetry | `deepMaskObject` over log `meta`; secret/email scrubbing of messages; no client IP in access logs |
| Related — A.8.24 cryptography, A.5.10 secret handling, A.5.34 privacy of PII | encryption module; `.gitignore` for secret files; IP dropped from logs |

## 6. Summary

### Files changed / added
- **Added:** `src/security/crypto.ts`, `src/security/masking/mask.ts`, `src/security/masking/config.ts`,
  `src/security/serializers.ts`, `src/migrations/encrypt-auth-header.ts`,
  `src/security/masking/mask.test.ts`, `src/security/crypto.test.ts`, `src/security/serializers.test.ts`,
  `SECURITY/DATA_MASKING.md`.
- **Modified:** `src/middleware/auth.middleware.ts` (`optionalAuthenticate`), `src/repositories/mcp.repo.ts`
  (encrypt on publish), `src/routes/mcp.routes.ts`, `src/routes/agent.routes.ts`, `src/routes/usage.routes.ts`,
  `src/routes/billing.routes.ts`, `src/lib/logger.ts`, `src/app.ts` (morgan), `scripts/create-api-key.mjs`
  (prod guard), `.env.example`, `.gitignore`, `package.json`, `tsconfig.json`.

### Behaviour changes (intentional, security-positive)
- Public reads of MCP versions no longer include `auth_header`. Authenticated marketplace consumers (e.g. chat-app via its service key) still get it.
- `system_prompt` is no longer returned for agents outside the caller's org.
- Access logs no longer contain client IP addresses.
All other responses are unchanged (owner-scoped routes serialize as owner → no-op).

### Human decisions required (out of scope for this change)
1. **Rotate the exposed secret files.** `env.production (1).local copy` and `env.production (2).local copy`
   were untracked but **not git-ignored** (now ignored, not deleted). Treat any secrets in them as
   compromised and rotate. Delete the local copies once rotated.
2. **Set `PLATEFORMAPISBENCRYPTIONKEY` (or `ENCRYPTION_KEY` locally) in every environment** and run the backfill migration; until then
   `auth_header` is stored as plaintext (still stripped from public responses).
3. **Authorization gaps (not addressed here):**
   - `X-Org-Id` header lets a trusted API key act on behalf of an arbitrary org when the key has no
     bound org — a cross-tenant vector to review.
   - `scopes` are populated on `req.caller` but **not enforced** on any route.
   These are access-control (A.8.2/A.8.3) issues, distinct from the A.8.11 masking work here.
