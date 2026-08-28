import { Pool } from 'pg'

let pool: Pool | null = null

export function resolveDatabaseUrl(): string | undefined {
  return process.env.POSTGRESQLSANDBOXPLATEFORMAPIURI || process.env.DATABASE_URL || undefined
}

export function getPool(): Pool {
  if (!pool) {
    const connectionString = resolveDatabaseUrl()

    pool = connectionString
      ? new Pool({ connectionString })
      : new Pool({
          host:     process.env.POSTGRES_HOST     || 'localhost',
          port:     parseInt(process.env.POSTGRES_PORT || '5432', 10),
          database: process.env.POSTGRES_DB       || 'platform',
          user:     process.env.POSTGRES_USER     || 'postgres',
          password: process.env.POSTGRES_PASSWORD || 'postgres',
        })
  }
  return pool
}
