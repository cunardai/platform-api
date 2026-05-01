import { Request, Response } from 'express'
import { app } from '../src/app'
import { getPool } from '../src/config/postgres'
import { logger } from '../src/lib/logger'

let initPromise: Promise<void> | null = null

function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = getPool().query('SELECT 1')
      .then(() => { logger.info('Vercel: DB ready') })
      .catch((err) => { initPromise = null; throw err })
  }
  return initPromise
}

export default async function handler(req: Request, res: Response) {
  await ensureInit()
  return app(req, res)
}
