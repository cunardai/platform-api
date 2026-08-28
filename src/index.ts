import { app } from './app'
import { getPool, requireDatabaseUrl } from './config/postgres'
import { logger } from './lib/logger'
import { config } from './config'

async function start() {
  try {
    requireDatabaseUrl()
    await getPool().query('SELECT 1')
    logger.info('Postgres connected')
  } catch (err) {
    logger.error('Postgres connection failed', { error: String(err) })
    process.exit(1)
  }

  const server = app.listen(config.port, () => {
    logger.info(`Platform API listening on http://localhost:${config.port}`)
  })

  process.on('SIGTERM', () => { server.close(() => process.exit(0)) })
}

start()
