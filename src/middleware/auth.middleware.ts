import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import crypto from 'crypto'
import { config } from '../config'
import { getPool } from '../config/postgres'
import { logger } from '../lib/logger'

declare global {
  namespace Express {
    interface Request {
      caller?: {
        user_id: string
        org_id: string | null
        scopes: string[]
        /**
         * How the caller authenticated. 'service' is the shared-service-token
         * path that arrives with the credits/metering work (branch
         * azure-deploy); it is in the union here so middleware/authz.ts is
         * identical on both branches and merges without conflict.
         */
        via: 'jwt' | 'api_key' | 'service'
        /**
         * Caller's role in `org_id`, from the verified token's `org_role`
         * claim. Undefined for API keys (org credentials carry scopes, not
         * roles) and for tokens minted before auth-service sent the claim —
         * middleware/authz.ts treats undefined as "deny", never as a default.
         */
        org_role?: string
        /** From the verified token's `is_platform_admin` claim. */
        is_platform_admin?: boolean
      }
    }
  }
}

const jwks = jwksClient({
  jwksUri: config.auth.jwksUri,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000,  // 10 minutes
})

function getSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    jwks.getSigningKey(kid, (err, key) => {
      if (err) return reject(err)
      resolve(key!.getPublicKey())
    })
  })
}

/**
 * Verify a bearer token from auth-service.
 *
 * `audience` is checked as well as `issuer` (PA-6). Without it, ANY token this
 * issuer mints was accepted here — including an id_token, whose `aud` is the
 * OAuth client_id and which is meant for the client, not for a resource
 * server. An id_token is trivially obtainable by any registered client and
 * carries `sub`/`org_id` all the same, so it would have authenticated a caller
 * as that user. Access tokens are minted with `aud` = the issuer URL, so that
 * is the expected audience; AUTH_EXPECTED_AUDIENCE overrides it for when the
 * platform moves to a dedicated resource audience.
 *
 * `algorithms` is pinned to RS256 so a token cannot present alg:none or an
 * HMAC over the public key. `kid` comes from the unverified header only to
 * select a JWKS key — the signature check is what makes it trustworthy.
 */
async function verifyJwt(token: string): Promise<jwt.JwtPayload> {
  const decoded = jwt.decode(token, { complete: true })
  if (!decoded || typeof decoded === 'string') throw new Error('Invalid token structure')
  const signingKey = await getSigningKey(decoded.header.kid ?? '')
  return jwt.verify(token, signingKey, {
    algorithms: ['RS256'],
    issuer: config.auth.issuer,
    audience: config.auth.expectedAudience,
  }) as jwt.JwtPayload
}

/** Shape a verified access-token payload into req.caller. */
function callerFromPayload(payload: jwt.JwtPayload): NonNullable<Request['caller']> {
  return {
    user_id: payload.sub ?? '',
    org_id: (payload.org_id as string) ?? null,
    scopes: (payload.scope as string ?? '').split(' ').filter(Boolean),
    via: 'jwt',
    // Passed through as-is; authz.ts validates the value before trusting it.
    org_role: typeof payload.org_role === 'string' ? payload.org_role : undefined,
    is_platform_admin: payload.is_platform_admin === true,
  }
}

async function verifyApiKey(raw: string): Promise<{ user_id: string; org_id: string; scopes: string[] } | null> {
  const hash = crypto.createHash('sha256').update(raw).digest('hex')
  const { rows } = await getPool().query<{ created_by: string | null; org_id: string; scopes: string[] }>(
    `SELECT created_by, org_id, scopes FROM api_keys
     WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
    [hash],
  )
  if (!rows[0] || !rows[0].org_id) return null
  getPool().query(`UPDATE api_keys SET last_used_at = NOW() WHERE key_hash = $1`, [hash]).catch(() => {})
  return { user_id: rows[0].created_by ?? '', org_id: rows[0].org_id, scopes: rows[0].scopes }
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  const apiKey = req.headers['x-api-key'] as string | undefined

  if (apiKey?.startsWith('sk_live_')) {
    try {
      const record = await verifyApiKey(apiKey)
      if (!record) {
        res.status(401).json({ success: false, error: { code: 'INVALID_API_KEY', message: 'API key is invalid, expired, or revoked' } })
        return
      }
      // An X-Org-Id override used to be honoured here. It was dead code —
      // verifyApiKey already returns null unless the key has an org_id, so the
      // `!record.org_id` condition could never hold — but it is removed rather
      // than left, because a client-supplied org header must never be able to
      // set the org a request acts on. The key's own org is the only answer.
      req.caller = { ...record, via: 'api_key' }
      next()
      return
    } catch (err) {
      logger.error('API key validation error', { error: String(err) })
      res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
      return
    }
  }

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7)
      const payload = await verifyJwt(token)
      req.caller = callerFromPayload(payload)
      next()
      return
    } catch (err) {
      res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } })
      return
    }
  }

  res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Provide Authorization: Bearer <token> or X-Api-Key: sk_live_...' } })
}

/**
 * Best-effort authentication for public/browse routes. Populates `req.caller` when valid
 * credentials are supplied, but never rejects the request — anonymous callers proceed with
 * no caller set. Serializers then decide owner-vs-public visibility. Used on routes that must
 * stay publicly readable yet return extra fields (e.g. a publisher's own `auth_header`) to the
 * authenticated owner.
 */
export async function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization
  const apiKey = req.headers['x-api-key'] as string | undefined

  if (!authHeader && !apiKey) return next()

  try {
    if (apiKey?.startsWith('sk_live_')) {
      const record = await verifyApiKey(apiKey)
      if (record) req.caller = { ...record, via: 'api_key' }
    } else if (authHeader?.startsWith('Bearer ')) {
      const payload = await verifyJwt(authHeader.slice(7))
      req.caller = callerFromPayload(payload)
    }
  } catch {
    // Invalid credentials on a public route → proceed as anonymous.
  }
  next()
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('Unhandled error', { error: err.message, stack: err.stack })
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
}
