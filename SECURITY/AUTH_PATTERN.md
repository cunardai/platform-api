# The platform auth pattern

**Status:** adopted · **Applies to:** platform-api, auth-service, Schema Studio (AIArchitect backend)
**Implements:** X-1 of `AIArchitect/docs/AUTH_HARDENING_PLAN.md`

Every finding in the 2026-09 audit was the same mistake in a different file.
Services **authenticated** — they established *who* was calling — and then did
not **authorize**: they never asked *whether that caller may do this*. Identity
was asserted by the client, in an `X-Org-Id` header, an `X-On-Behalf-Of-Org`
header, or an org field in the body, and trusted without checking the caller
owns it. Several also failed **open** when an env var was unset.

Three rules follow. They are short on purpose.

---

## 1. Derive org and identity from a verified credential, never from the client

A header or body field is a *request*, not a fact. Org scope comes from
`req.caller`, which `authenticate()` builds from exactly three things:

| Source | What it proves |
|---|---|
| A JWKS-verified RS256 access token | The user, their org, their role in it |
| A hashed API key row | The org that owns the key, and its scopes |
| A registered service token | Which trusted backend is calling |

Nothing else may set an org. `scripts/check-org-claims.mjs` fails the build on
a read of `x-org-id` / `x-on-behalf-of-org` / `req.body.org*` / `req.query.orgId`,
and runs in CI on every pull request.

There is exactly **one** allowlisted exception on the platform:
`X-On-Behalf-Of-Org` in `src/middleware/service-token.ts`. It survives because
the credential in front of it is a platform secret matched in constant time
against a *per-caller* registration, and the named org is then checked against
that caller's allow-list. Adding a second exception means editing the
allowlist and writing down why — "it's behind auth" is not a reason, since
that was true of every finding in the audit.

## 2. Role-check privileged, admin, and billing actions

Authentication is not authorization. `authenticate()` answering successfully
means only that the caller is *someone*.

Reference implementation: **`src/middleware/authz.ts`**.

| Gate | Use for |
|---|---|
| `requireService` | Actions whose blast radius is the whole platform, or that mint money — credit grants, global model rates |
| `requirePlatformAdmin` | The operating company's own staff |
| `requireOrgRole(role, scopes)` | Org-scoped privileged settings — pricing config, event-type costs |

Two things about `requireOrgRole` that are easy to get wrong:

- **Roles come from the token, not from a lookup here.** auth-service stamps
  the caller's resolved `org_role` at issue time (`authzClaims` in
  `oauth.routes.ts`). It is a *snapshot* for the life of one access token, so
  do **not** gate irreversible or money-minting actions on it — those take
  `requireService`.
- **API keys have no role.** They are org credentials with a free-form scope
  list, so they must instead carry a named scope (`BILLING_WRITE_SCOPE`). A key
  with no scopes is denied, not assumed privileged.

In auth-service the equivalent primitives are `requireOrgAccess` (membership +
role, from the DB) and the pure `decideRoleChange` in `lib/org-roles.ts`.

## 3. Fail closed

Unset config, unverifiable token, unknown input → **deny**.

Concretely, from the bugs this rule would have prevented:

- **An absent claim is not a permissive one.** A token with no `org_role` is
  denied. Tokens minted before the claim existed lose access to gated
  endpoints rather than keeping their old unauthorized access.
- **An unmodelled value must not produce a rank.** `ROLE_RANK['user']` is
  `undefined`, and `undefined < requiredRank` is `false` in JavaScript — so
  auth-service's org guard silently admitted *every* legacy role at *every*
  level, up to `owner`. Resolve roles through a function that returns `null`
  for anything it cannot map, and treat `null` as deny.
- **A weak secret is dropped, not warned about.** A placeholder or too-short
  service token is not registered at all, and in production the process
  refuses to boot. A secret that "works" while being guessable is worse than
  one that does not work, because nothing surfaces it.
- **Zero configured credentials disables a surface**, rather than opening it.
- **Compare secrets in constant time**, over equal-length digests
  (`crypto.timingSafeEqual` on SHA-256), and reject a duplicated header rather
  than picking one of its values.
- **404, not 403, for a row the caller may not see.** Distinguishing "exists
  but forbidden" from "does not exist" confirms the id, which is the only
  thing an id-guessing caller wants.

---

## Reviewer's checklist

For any new or changed handler:

- [ ] Does it read an org from a header, body, or query? → `npm run lint:authz`
      should be failing. Use `req.caller.org_id`.
- [ ] Does it write pricing, credits, roles, or another org's data? → which
      gate from `authz.ts` is on it?
- [ ] Does it return rows? → are private rows filtered by ownership, not just
      masked field-by-field? Masking a secret column does not help when the row
      was never meant to be visible.
- [ ] What happens when the relevant env var is unset — deny, or allow?
- [ ] Is the authorization decision unit-testable without a DB? Extract it as
      a pure function if not (`decideRoleChange`, `browseScope`, `isVisibleTo`).

## Compliance

ISO 27001 A.5.15, A.8.2, A.8.3 (access control / least privilege) ·
A.8.27, A.8.13, A.8.24 (secure defaults, secrets) ·
SOC 2 CC6.1–6.3, CC6.6 · Platform P1 tenant-isolation control.
