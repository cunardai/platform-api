// ── Authorization ────────────────────────────────────────────────────────────
//
// authenticate() answers "who is calling?". Nothing here answered "may they do
// this?", so every privileged endpoint was effectively gated on possession of
// any valid token for any org — which is how POST /credits/grant let a caller
// mint credits for its own org, and PUT /credits/model-rates/:model let it
// rewrite token pricing for every tenant on the platform.
//
// Three rules, applied per route:
//
//   requireService     — service-to-service only. For actions whose blast
//                        radius is the whole platform, or that mint money.
//   requireOrgRole     — the caller must hold at least this role IN the org
//                        the token is bound to. For org-scoped billing config.
//   requirePlatformAdmin — the operating company's own staff.
//
// All three read only VERIFIED facts: `req.caller`, which authenticate() built
// from a JWKS-verified JWT, a hashed API key, or the service token. No client
// header or body field feeds any decision here.
//
// All three fail closed. A caller whose role cannot be established is denied,
// not defaulted — an absent claim is not a permissive one.
import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger'

/**
 * Scope an API key must carry to change billing configuration.
 *
 * API keys are ORG credentials with a free-form scope list, not user
 * credentials, so they have no role to check. Requiring a named scope keeps
 * automation possible while making the grant deliberate: an existing key with
 * no scopes is denied, which is the fail-closed direction and a change from
 * the previous behaviour of allowing any authenticated caller.
 */
export const BILLING_WRITE_SCOPE = ['billing:write']

/** Roles, least to most privileged. Mirrors auth-service lib/org-roles.ts. */
export const ORG_ROLES = ['member', 'admin', 'owner'] as const
export type OrgRole = (typeof ORG_ROLES)[number]
const ROLE_RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 }

/**
 * Resolve the caller's org role, or null when it cannot be established.
 *
 * Returning null — rather than a default — is deliberate: a token minted
 * before auth-service started sending `org_role`, or one whose role claim is a
 * value this service does not model, must be denied. Note the lookup is on a
 * validated key, so an unmodelled value can never produce a rank by accident
 * (`undefined < n` is false in JavaScript, which is exactly the trap that let
 * unmodelled roles through the equivalent check in auth-service).
 */
export function callerOrgRole(req: Request): OrgRole | null {
  const claimed = req.caller?.org_role
  if (typeof claimed !== 'string') return null
  return (ORG_ROLES as readonly string[]).includes(claimed) ? (claimed as OrgRole) : null
}

function deny(res: Response, code: string, message: string): void {
  res.status(403).json({ success: false, error: { code, message } })
}

/**
 * Restrict a route to trusted backend services (X-Service-Token).
 *
 * Use this for anything that is not scoped to one tenant, or that creates
 * value: credit grants and global model rates are provisioning decisions made
 * by the platform, never self-served by whoever holds a user token.
 */
export function requireService(req: Request, res: Response, next: NextFunction): void {
  if (req.caller?.via !== 'service') {
    logger.warn('Denied privileged request: service credential required', {
      path: req.path, via: req.caller?.via ?? 'anonymous', org_id: req.caller?.org_id ?? null,
    })
    return deny(res, 'SERVICE_ONLY', 'This endpoint is available to platform services only.')
  }
  next()
}

/** Restrict a route to platform staff (is_platform_admin on a verified token). */
export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.caller?.via === 'service') return next()
  if (req.caller?.is_platform_admin !== true) {
    logger.warn('Denied privileged request: platform admin required', { path: req.path, via: req.caller?.via ?? 'anonymous' })
    return deny(res, 'ADMIN_ONLY', 'Platform admin access required.')
  }
  next()
}

/**
 * Require at least `minRole` in the org the caller's token is bound to.
 *
 * A service caller passes: it acts on behalf of the platform and its own
 * routes gate it. An API-key caller has no role — keys are org credentials,
 * not user ones — so it must instead carry an explicit scope from
 * `requiredScopes`; without one it is denied rather than assumed privileged.
 */
export function requireOrgRole(minRole: OrgRole, requiredScopes: string[] = []) {
  return function orgRoleGate(req: Request, res: Response, next: NextFunction): void {
    const caller = req.caller
    if (!caller) return deny(res, 'FORBIDDEN', 'Authentication required.')
    if (caller.via === 'service') return next()
    if (caller.is_platform_admin === true) return next()

    if (caller.via === 'api_key') {
      if (requiredScopes.length && requiredScopes.some((s) => caller.scopes.includes(s))) return next()
      logger.warn('Denied privileged request: API key lacks the required scope', {
        path: req.path, required: requiredScopes, held: caller.scopes,
      })
      return deny(
        res,
        'INSUFFICIENT_SCOPE',
        requiredScopes.length
          ? `This endpoint requires an API key with one of these scopes: ${requiredScopes.join(', ')}.`
          : 'This endpoint cannot be called with an API key.',
      )
    }

    const role = callerOrgRole(req)
    if (!role) {
      logger.warn('Denied privileged request: token carries no usable org_role claim', {
        path: req.path, org_id: caller.org_id, claim: caller.org_role ?? null,
      })
      return deny(res, 'FORBIDDEN', `This endpoint requires the ${minRole} role in your organisation.`)
    }
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) {
      return deny(res, 'FORBIDDEN', `This endpoint requires the ${minRole} role in your organisation; you hold ${role}.`)
    }
    next()
  }
}
