/**
 * Field-level encryption at rest — AES-256-GCM.
 *
 * ISO 27001:2022 A.8.24 (Use of cryptography), A.8.11 (Data masking — encryption
 * removes the plaintext secret from persisted rows).
 *
 * Design goals:
 *  - Ciphertext is self-describing: `enc:` prefix + base64(iv | authTag | ciphertext).
 *  - SAFE / DEGRADABLE: if `ENCRYPTION_KEY` is unset (or malformed) we pass the value
 *    through unchanged instead of throwing, so an un-keyed environment keeps working
 *    exactly as before (behaviour-preserving). Decrypt is symmetric: unknown/plaintext
 *    input is returned as-is.
 *  - Idempotent encrypt: an already-`enc:` value is never double-encrypted.
 *
 * Key: PLATEFORMAPISBENCRYPTIONKEY (preferred, Azure Key Vault-backed) or
 * ENCRYPTION_KEY (legacy local/dev fallback) — either must be 64 hex chars
 * (= 32 bytes / 256 bits).
 */
import crypto from 'crypto'

const PREFIX = 'enc:'
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16

let warnedBadKey = false

function resolveKeyHex(): string | undefined {
  return process.env.PLATEFORMAPISBENCRYPTIONKEY || process.env.ENCRYPTION_KEY
}

function getKey(): Buffer | null {
  const hex = resolveKeyHex()
  if (!hex) return null
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    if (!warnedBadKey) {
      // Never print the key itself.
      // eslint-disable-next-line no-console
      console.warn('[crypto] PLATEFORMAPISBENCRYPTIONKEY/ENCRYPTION_KEY is set but is not 64 hex chars (32 bytes); encryption disabled (pass-through).')
      warnedBadKey = true
    }
    return null
  }
  return Buffer.from(hex, 'hex')
}

/** True when the value is already an `enc:`-tagged ciphertext produced by this module. */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX)
}

/** Is a usable 256-bit key configured? */
export function isCryptoEnabled(): boolean {
  return getKey() !== null
}

/**
 * Encrypt a plaintext string. Returns the original value unchanged when:
 *  - the value is null/undefined,
 *  - the value is already encrypted (idempotent),
 *  - no valid key is configured (pass-through / degradable).
 */
export function encrypt(plaintext: string | null | undefined): string | null {
  if (plaintext == null) return null
  if (isEncrypted(plaintext)) return plaintext
  const key = getKey()
  if (!key) return plaintext
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64')
}

/**
 * Decrypt a value produced by {@link encrypt}. Returns the original value unchanged when:
 *  - the value is null/undefined,
 *  - the value is not `enc:`-tagged (already plaintext — pass-through),
 *  - no valid key is configured,
 *  - decryption fails (tampered / wrong key) — returns the raw stored value rather than throwing.
 */
export function decrypt(value: string | null | undefined): string | null {
  if (value == null) return null
  if (!isEncrypted(value)) return value
  const key = getKey()
  if (!key) return value
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64')
    const iv = raw.subarray(0, IV_BYTES)
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES)
    const decipher = crypto.createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
  } catch {
    return value
  }
}
