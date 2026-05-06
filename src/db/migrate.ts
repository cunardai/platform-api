import '../config'
import fs from 'fs'
import path from 'path'
import { getPool } from '../config/postgres'

async function migrate(): Promise<void> {
  const pool = getPool()

  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  const migrationsDir = path.join(__dirname, '../../migrations')
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  console.info('Running migrations')

  for (const file of files) {
    const { rows } = await pool.query<{ id: number }>(`SELECT id FROM migrations WHERE name = $1`, [file])
    if (rows.length > 0) {
      console.info(`  skip  ${file}`)
      continue
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8')
    await pool.query(sql)
    await pool.query(`INSERT INTO migrations (name) VALUES ($1)`, [file])
    console.info(`  apply ${file}`)
  }

  console.info('Migrations complete')
  await pool.end()
}

migrate().catch((err) => {
  console.error('Migration failed', err)
  process.exit(1)
})
