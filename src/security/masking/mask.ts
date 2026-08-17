/**
 * Central data-masking utilities — ISO 27001:2022 A.8.11 (Data masking).
 *
 * Pure, dependency-free (Node `crypto` only) and unit-tested. No logging, no I/O —
 * safe to import from anywhere (including the logger) without creating cycles.
 */
import crypto from 'crypto'

export const REDACTED = '[REDACTED]'

/** Replace a value entirely. Use for secrets/tokens/passwords. */
export function redact(_value?: unknown): string {
  return REDACTED
}

/**
 * Keep the last `keep` characters, mask the rest with `*`.
 * `maskPartial('sk_live_abcd1234')` → `************1234`.
 * Short values (length <= keep) are fully masked. Idempotent for already-partial values.
 */
export function maskPartial(value: string | number | null | undefined, keep = 4): string {
  if (value == null) return ''
  const s = String(value)
  if (keep <= 0 || s.length <= keep) return '*'.repeat(s.length)
  return '*'.repeat(s.length - keep) + s.slice(-keep)
}

/**
 * Mask the local part of an email, preserve the domain: `john.doe@x.com` → `j***@x.com`.
 * Non-email strings are fully masked.
 */
export function maskEmail(value: string | null | undefined): string {
  if (value == null) return ''
  const s = String(value)
  const at = s.indexOf('@')
  if (at < 1) return maskPartial(s, 0)
  const local = s.slice(0, at)
  const domain = s.slice(at + 1)
  return `${local[0] ?? ''}***@${domain}`
}

/** One-way SHA-256 hex digest. */
export function hashValue(value: string | null | undefined): string {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex')
}

/**
 * Stable pseudonym via HMAC-SHA256 keyed on `PSEUDONYM_KEY`.
 * Falls back to a plain SHA-256 hash when no key is configured (still deterministic).
 */
export function pseudonymize(value: string | null | undefined): string {
  const key = process.env.PSEUDONYM_KEY
  const input = String(value ?? '')
  if (!key) return hashValue(input)
  return crypto.createHmac('sha256', key).update(input).digest('hex')
}

// ─── Key-name driven deep masking ─────────────────────────────────────────────

type Masker = 'redact' | 'email' | 'partial'

/** Decide how (if at all) to mask a value based on its key name. */
function maskerForKey(key: string): Masker | null {
  const k = key.toLowerCase().replace(/[_\-\s]/g, '')
  if (k.includes('email')) return 'email'
  if (k.startsWith('stripe')) return 'partial'
  if (/(secret|password|passwd|token|authorization|authheader|apikey)/.test(k)) return 'redact'
  if (k === 'ip' || /ipaddress|clientip|remoteip|ipaddr/.test(k)) return 'redact'
  return null
}

/** A value we should not re-process (avoids double-masking on repeated passes). */
function isAlreadyMasked(value: unknown): boolean {
  return typeof value === 'string' && (value === REDACTED || value.startsWith('enc:') || value.startsWith('***@'))
}

function applyMasker(value: unknown, masker: Masker): unknown {
  if (value == null) return value
  if (isAlreadyMasked(value)) return value
  // A structured value under a sensitive key is redacted wholesale — safest.
  if (typeof value === 'object') return REDACTED
  const s = String(value)
  switch (masker) {
    case 'email':   return maskEmail(s)
    case 'partial': return maskPartial(s, 4)
    case 'redact':  return REDACTED
  }
}

export interface DeepMaskOpts {
  /** Max recursion depth before values are truncated. Default 12. */
  maxDepth?: number
  /** Internal — cycle guard. */
  seen?: WeakSet<object>
  /** Internal — current depth. */
  depth?: number
}

/**
 * Recursively mask an object/array by key name. Handles null, nested objects, arrays,
 * circular references, and already-masked values (idempotent). Returns a masked deep copy;
 * the input is never mutated.
 */
export function deepMaskObject(input: unknown, opts: DeepMaskOpts = {}): unknown {
  const maxDepth = opts.maxDepth ?? 12
  const depth = opts.depth ?? 0
  const seen = opts.seen ?? new WeakSet<object>()

  if (input == null) return input
  if (typeof input !== 'object') return input
  if (depth > maxDepth) return '[TRUNCATED]'
  if (seen.has(input)) return '[CIRCULAR]'
  seen.add(input)

  if (Array.isArray(input)) {
    return input.map((item) => deepMaskObject(item, { maxDepth, seen, depth: depth + 1 }))
  }

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const masker = maskerForKey(key)
    if (masker) {
      out[key] = applyMasker(value, masker)
    } else if (value !== null && typeof value === 'object') {
      out[key] = deepMaskObject(value, { maxDepth, seen, depth: depth + 1 })
    } else {
      out[key] = value
    }
  }
  return out
}

// ─── Free-text secret scrubbing (for log message strings) ─────────────────────

const SECRET_PATTERNS: RegExp[] = [
  /sk_live_[A-Za-z0-9]+/g,
  /sk_test_[A-Za-z0-9]+/g,
  /rk_(?:live|test)_[A-Za-z0-9]+/g,
  /whsec_[A-Za-z0-9]+/g,
  /pk_(?:live|test)_[A-Za-z0-9]+/g,
  /Bearer\s+[A-Za-z0-9._\-]+/gi,
  /eyJ[A-Za-z0-9._\-]{10,}/g, // JWT-ish
]

const EMAIL_RE = /([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g

/** Redact secret-looking substrings and emails from a free-text string (e.g. a log message). */
export function redactSecretsInString(input: string): string {
  let out = String(input ?? '')
  for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED)
  out = out.replace(EMAIL_RE, (_m, local: string, domain: string) => `${local[0] ?? ''}***@${domain}`)
  return out
}
