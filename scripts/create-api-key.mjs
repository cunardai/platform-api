/**
 * One-time script: creates the api_keys table if missing, then inserts a new sk_live_ key.
 * Run with: node scripts/create-api-key.mjs
 *
 * WARNING: this mints a REAL, LIVE `sk_live_` API key with usage:read/usage:write scopes
 * and prints the raw secret to stdout. Treat the output as a credential. It refuses to run
 * when NODE_ENV=production unless you pass --force.
 */
import crypto from 'crypto'
import pg from 'pg'
import { config } from 'dotenv'

config()

// ─── Production safety guard ───────────────────────────────────────────────────
const FORCE = process.argv.includes('--force')
if (process.env.NODE_ENV === 'production' && !FORCE) {
  console.error('Refusing to create a live API key with NODE_ENV=production.')
  console.error('This mints a real sk_live_ credential. Re-run with --force only if you are certain.')
  process.exit(1)
}
if (process.env.NODE_ENV === 'production' && FORCE) {
  console.warn('NODE_ENV=production and --force supplied — minting a REAL live API key.')
}

const { Pool } = pg
const connectionString = process.env.POSTGRESQLDBSANDBOXURI || process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('Missing DB connection string. Set POSTGRESQLDBSANDBOXURI or DATABASE_URL.')
}
const pool = new Pool({ connectionString })

async function main() {
  // 0. Show orgs
  const { rows: orgs } = await pool.query(`SELECT id, name, slug FROM organizations LIMIT 10`)
  console.log('Organizations:', JSON.stringify(orgs, null, 2))

  // 1. Create table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      key_hash     TEXT        UNIQUE NOT NULL,
      org_id       TEXT        NOT NULL,
      created_by   TEXT,
      scopes       TEXT[]      NOT NULL DEFAULT '{"usage:read","usage:write"}',
      last_used_at TIMESTAMPTZ,
      expires_at   TIMESTAMPTZ,
      revoked_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // 2. Generate key
  const raw = 'sk_live_' + crypto.randomBytes(32).toString('hex')
  const hash = crypto.createHash('sha256').update(raw).digest('hex')

  const org_id = process.env.ORG_ID || '2ce7e6cb-a120-402d-bfcb-03cff192947d' // CunardAI org

  const prefix = raw.slice(0, 16)

  await pool.query(
    `INSERT INTO api_keys (name, key_hash, key_prefix, org_id, created_by, scopes)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (key_hash) DO NOTHING`,
    ['forest-chat', hash, prefix, org_id, null, ['usage:read', 'usage:write']]
  )

  console.log('API key created successfully!')
  console.log(`Raw key (add to PLATFORM_API_KEY in chat-app backend/.env):`)
  console.log(raw)
  console.log(`org_id: ${org_id}`)

  await pool.end()
}

main().catch(err => { console.error(err); process.exit(1) })
