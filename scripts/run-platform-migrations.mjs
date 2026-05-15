import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { config } from 'dotenv'

config()

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations')

await pool.query(`CREATE TABLE IF NOT EXISTS _platform_migrations (name TEXT PRIMARY KEY, ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)

const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()
for (const file of files) {
  const { rows } = await pool.query(`SELECT name FROM _platform_migrations WHERE name = $1`, [file])
  if (rows.length) { console.log('skip', file); continue }
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
  await pool.query(sql)
  await pool.query(`INSERT INTO _platform_migrations (name) VALUES ($1)`, [file])
  console.log('ran ', file)
}
console.log('All platform migrations done.')
await pool.end()
