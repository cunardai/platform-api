import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  redact,
  maskPartial,
  maskEmail,
  hashValue,
  pseudonymize,
  deepMaskObject,
  redactSecretsInString,
  REDACTED,
} from './mask'

test('redact always returns the redaction sentinel', () => {
  assert.equal(redact('anything'), REDACTED)
  assert.equal(redact(), REDACTED)
})

test('maskPartial keeps last N chars', () => {
  assert.equal(maskPartial('sk_live_abcd1234'), '************1234')
  assert.equal(maskPartial('sk_live_abcd1234', 2), '**************34')
  assert.equal(maskPartial('ab', 4), '**') // shorter than keep → fully masked
  assert.equal(maskPartial('secret', 0), '******')
  assert.equal(maskPartial(null), '')
  assert.equal(maskPartial(undefined), '')
})

test('maskPartial is idempotent', () => {
  const once = maskPartial('cus_ABCDEFGH', 4)
  assert.equal(maskPartial(once, 4), once)
})

test('maskEmail masks local part, keeps domain', () => {
  assert.equal(maskEmail('john.doe@x.com'), 'j***@x.com')
  assert.equal(maskEmail('a@example.com'), 'a***@example.com')
  assert.equal(maskEmail('not-an-email'), '************') // 12 chars fully masked
})

test('hashValue is deterministic sha256 hex', () => {
  assert.equal(hashValue('hello'), hashValue('hello'))
  assert.match(hashValue('hello'), /^[0-9a-f]{64}$/)
  assert.notEqual(hashValue('a'), hashValue('b'))
})

test('pseudonymize falls back to hash without key, uses HMAC with key', () => {
  delete process.env.PSEUDONYM_KEY
  assert.equal(pseudonymize('user-1'), hashValue('user-1'))

  process.env.PSEUDONYM_KEY = 'test-pseudonym-key'
  const withKey = pseudonymize('user-1')
  assert.match(withKey, /^[0-9a-f]{64}$/)
  assert.notEqual(withKey, hashValue('user-1')) // HMAC differs from plain hash
  assert.equal(withKey, pseudonymize('user-1')) // deterministic
  delete process.env.PSEUDONYM_KEY
})

test('pseudonymize prefers PLATEFORMAPISBPSEUDONYMKEY over legacy PSEUDONYM_KEY', () => {
  process.env.PLATEFORMAPISBPSEUDONYMKEY = 'vault-key'
  process.env.PSEUDONYM_KEY = 'legacy-key'
  const withVaultKey = pseudonymize('user-1')
  delete process.env.PSEUDONYM_KEY
  assert.equal(pseudonymize('user-1'), withVaultKey) // same result using only the vault key
  delete process.env.PLATEFORMAPISBPSEUDONYMKEY
})

test('deepMaskObject handles null and primitives', () => {
  assert.equal(deepMaskObject(null), null)
  assert.equal(deepMaskObject(undefined), undefined)
  assert.equal(deepMaskObject('plain'), 'plain')
  assert.equal(deepMaskObject(42), 42)
})

test('deepMaskObject masks sensitive keys by name', () => {
  const out = deepMaskObject({
    id: 'keep-me',
    password: 'hunter2',
    api_key: 'sk_live_xxx',
    authorization: 'Bearer abc',
    auth_header: 'Bearer xyz',
    access_token: 'tok_123',
    stripe_customer_id: 'cus_ABCDEFGH',
    user_email: 'jane@corp.com',
    ip: '203.0.113.7',
    normal: 'value',
  }) as Record<string, unknown>

  assert.equal(out.id, 'keep-me')
  assert.equal(out.normal, 'value')
  assert.equal(out.password, REDACTED)
  assert.equal(out.api_key, REDACTED)
  assert.equal(out.authorization, REDACTED)
  assert.equal(out.auth_header, REDACTED)
  assert.equal(out.access_token, REDACTED)
  assert.equal(out.stripe_customer_id, '********EFGH')
  assert.equal(out.user_email, 'j***@corp.com')
  assert.equal(out.ip, REDACTED)
})

test('deepMaskObject recurses into nested objects and arrays', () => {
  const out = deepMaskObject({
    outer: { token: 'abc', items: [{ password: 'p1' }, { password: 'p2' }] },
    list: ['ok', { secret: 's' }],
  }) as any
  assert.equal(out.outer.token, REDACTED)
  assert.equal(out.outer.items[0].password, REDACTED)
  assert.equal(out.outer.items[1].password, REDACTED)
  assert.equal(out.list[0], 'ok')
  assert.equal(out.list[1].secret, REDACTED)
})

test('deepMaskObject is idempotent on already-masked values', () => {
  const first = deepMaskObject({ password: 'x', email: 'a@b.com' }) as Record<string, unknown>
  const second = deepMaskObject(first) as Record<string, unknown>
  assert.deepEqual(second, first)
})

test('deepMaskObject does not mutate input and handles circular refs', () => {
  const input: any = { password: 'x', nested: {} }
  input.nested.parent = input // circular
  const out = deepMaskObject(input) as any
  assert.equal(input.password, 'x') // original untouched
  assert.equal(out.password, REDACTED)
  assert.equal(out.nested.parent, '[CIRCULAR]')
})

test('deepMaskObject redacts structured value under a sensitive key', () => {
  const out = deepMaskObject({ secret: { nested: 'thing' } }) as Record<string, unknown>
  assert.equal(out.secret, REDACTED)
})

test('redactSecretsInString scrubs secrets and emails, keeps domain', () => {
  const s = 'key=sk_live_deadbeef token Bearer abc.def user jane@corp.com whsec_zzz'
  const out = redactSecretsInString(s)
  assert.ok(!out.includes('sk_live_deadbeef'))
  assert.ok(!out.includes('whsec_zzz'))
  assert.ok(!out.includes('Bearer abc.def'))
  assert.ok(out.includes('j***@corp.com'))
  assert.ok(!out.includes('jane@corp.com'))
})
