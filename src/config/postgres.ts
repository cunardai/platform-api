import { Pool } from 'pg'

let pool: Pool | null = null

function isValidDatabaseUrl(value: string | undefined): value is string {
  if (!value) return false

  const trimmed = value.trim()
  if (!trimmed) return false

  try {
    const parsed = new URL(trimmed)
    const protocolOk = parsed.protocol === 'postgres:' || parsed.protocol === 'postgresql:'
    return protocolOk && Boolean(parsed.hostname)
  } catch {
    return false
  }
}

export function resolveDatabaseUrl(): string | undefined {
  const candidates = [
    process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI,
    process.env.DATABASE_URL,
  ]

  for (const candidate of candidates) {
    if (isValidDatabaseUrl(candidate)) return candidate.trim()
  }

  return undefined
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = resolveDatabaseUrl()

    if (connectionString) {
      pool = new Pool({ connectionString })
      return pool
    }

    const fallbackHost = process.env.POSTGRES_HOST || 'localhost'
    const fallbackPort = parseInt(process.env.POSTGRES_PORT || '5432', 10)
    const fallbackDatabase = process.env.POSTGRES_DB || 'platform'
    const fallbackUser = process.env.POSTGRES_USER || 'postgres'
    const fallbackPassword = process.env.POSTGRES_PASSWORD || 'postgres'

    pool = new Pool({
      host: fallbackHost,
      port: fallbackPort,
      database: fallbackDatabase,
      user: fallbackUser,
      password: fallbackPassword,
    })
  }

  return pool
}

export function requireDatabaseUrl(): string {
  const connectionString = resolveDatabaseUrl()

  if (connectionString) return connectionString

  throw new Error(
    'Missing valid PostgreSQL connection string. Set POSTGRESQLSANDBOXPLATEFORMAPIURI or DATABASE_URL.'
  )
}
