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
        via: 'jwt' | 'api_key'
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

async function verifyJwt(token: string): Promise<jwt.JwtPayload> {
  const decoded = jwt.decode(token, { complete: true })
  if (!decoded || typeof decoded === 'string') throw new Error('Invalid token structure')
  const signingKey = await getSigningKey(decoded.header.kid ?? '')
  return jwt.verify(token, signingKey, {
    algorithms: ['RS256'],
    issuer: config.auth.issuer,
  }) as jwt.JwtPayload
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
      req.caller = {
        user_id: payload.sub ?? '',
        org_id: (payload.org_id as string) ?? null,
        scopes: (payload.scope as string ?? '').split(' ').filter(Boolean),
        via: 'jwt',
      }
      next()
      return
    } catch (err) {
      res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } })
      return
    }
  }

  res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Provide Authorization: Bearer <token> or X-Api-Key: sk_live_...' } })
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  logger.error('Unhandled error', { error: err.message, stack: err.stack })
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } })
}
