/**
 * Re-encryption migration — encrypt existing plaintext `mcp_versions.auth_header` rows.
 *
 * ISO 27001:2022 A.8.11 / A.8.24. Backfills field-level encryption for rows written before
 * encryption-at-rest was wired in.
 *
 *   Dry run (default, writes nothing):   npm run migrate:encrypt-auth-header
 *   Apply:                               npm run migrate:encrypt-auth-header -- --apply
 *
 * Properties:
 *  - NON-DESTRUCTIVE: only rewrites `auth_header`, one row at a time, inside a check.
 *  - IDEMPOTENT: rows already prefixed `enc:` are skipped; re-running is safe.
 *  - Requires a valid ENCRYPTION_KEY (64 hex). Without it `encrypt()` is a no-op, so the
 *    migration refuses to run rather than silently "encrypting" to plaintext.
 *  - Never prints secret values (only row ids and counts).
 */
import '../config'
import { getPool } from '../config/postgres'
import { encrypt, isEncrypted, isCryptoEnabled } from '../security/crypto'

const APPLY = process.argv.includes('--apply')

async function run(): Promise<void> {
  if (!isCryptoEnabled()) {
    console.error('[encrypt-auth-header] ENCRYPTION_KEY is not set to a valid 64-hex key. Aborting (nothing to do).')
    process.exit(1)
  }

  const pool = getPool()
  const { rows } = await pool.query<{ id: string; auth_header: string | null }>(
    `SELECT id, auth_header FROM mcp_versions WHERE auth_header IS NOT NULL AND auth_header <> ''`,
  )

  let toEncrypt = 0
  let alreadyEncrypted = 0
  let updated = 0

  for (const row of rows) {
    if (isEncrypted(row.auth_header)) { alreadyEncrypted++; continue }
    toEncrypt++
    if (!APPLY) continue
    const enc = encrypt(row.auth_header)
    if (!isEncrypted(enc)) {
      // Defensive: should never happen because isCryptoEnabled() passed.
      console.error(`[encrypt-auth-header] refused to write non-encrypted value for row ${row.id}; aborting.`)
      process.exit(1)
    }
    await pool.query(`UPDATE mcp_versions SET auth_header = $1 WHERE id = $2`, [enc, row.id])
    updated++
  }

  console.log(
    `[encrypt-auth-header] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} ` +
    `total_with_auth_header=${rows.length} already_encrypted=${alreadyEncrypted} ` +
    `plaintext_needing_encryption=${toEncrypt} updated=${updated}`,
  )
  if (!APPLY && toEncrypt > 0) {
    console.log('[encrypt-auth-header] Re-run with `-- --apply` to encrypt the rows above.')
  }

  await pool.end()
}

run().catch((err) => {
  console.error('[encrypt-auth-header] failed:', String(err))
  process.exit(1)
})
