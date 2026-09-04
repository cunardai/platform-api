// ── Authorization (as distinct from authentication) ─────────────────────────
//
// auth.middleware.ts answers "who is this?". It does NOT answer "may they do
// this?", and `authenticate` alone was the only gate on the credit routes —
// which is how POST /credits/grant let any authenticated caller mint credits
// for its own org, and PUT /credits/model-rates/:model let any tenant rewrite
// the GLOBAL token price table for every other tenant.
//
// Deliberately minimal: only `requireService` lives here, because it is the
// only check the credit routes need and the only one that depends on nothing
// beyond `req.caller.via` — which auth.middleware.ts already sets. Role-based
// variants (requireOrgRole / requirePlatformAdmin) exist on the hardening
// branch and read `org_role` / `is_platform_admin`; those claims are NOT part
// of this branch's `req.caller`, so importing them here would either fail to
// typecheck or silently deny every caller.
import { Request, Response, NextFunction } from 'express'
import { logger } from '../lib/logger'

/**
 * Restrict a route to trusted backend services (X-Service-Token).
 *
 * Use for anything not scoped to one tenant, or that creates value: credit
 * grants, global model rates and pricing config are PROVISIONING decisions
 * made by the platform, never self-served by whoever holds a user token.
 *
 * Fails closed. `via` is set only after auth.middleware.ts has verified the
 * shared token, and an anonymous or user/api-key caller is denied — so an
 * unset PLATFORM_SERVICE_TOKEN makes these routes unreachable rather than
 * public, which is the safe direction for a money surface.
 */
export function requireService(req: Request, res: Response, next: NextFunction): void {
  if (req.caller?.via !== 'service') {
    logger.warn('Denied privileged request: service credential required', {
      path: req.path,
      via: req.caller?.via ?? 'anonymous',
      org_id: req.caller?.org_id ?? null,
    })
    res.status(403).json({
      success: false,
      error: { code: 'SERVICE_ONLY', message: 'This endpoint is available to platform services only.' },
    })
    return
  }
  next()
}
