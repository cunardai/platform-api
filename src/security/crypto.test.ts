import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { encrypt, decrypt, isEncrypted, isCryptoEnabled } from './crypto'

const KEY = crypto.randomBytes(32).toString('hex') // 64 hex chars

test('pass-through when no key is configured', () => {
  delete process.env.ENCRYPTION_KEY
  assert.equal(isCryptoEnabled(), false)
  assert.equal(encrypt('secret'), 'secret')
  assert.equal(decrypt('secret'), 'secret')
})

test('round-trips with a valid key', () => {
  process.env.ENCRYPTION_KEY = KEY
  assert.equal(isCryptoEnabled(), true)
  const ct = encrypt('super-secret-token')
  assert.ok(isEncrypted(ct))
  assert.notEqual(ct, 'super-secret-token')
  assert.equal(decrypt(ct), 'super-secret-token')
  delete process.env.ENCRYPTION_KEY
})

test('encrypt is idempotent — never double-encrypts', () => {
  process.env.ENCRYPTION_KEY = KEY
  const ct = encrypt('value')!
  assert.equal(encrypt(ct), ct)
  assert.equal(decrypt(encrypt(ct)!), 'value')
  delete process.env.ENCRYPTION_KEY
})

test('null / undefined handling', () => {
  process.env.ENCRYPTION_KEY = KEY
  assert.equal(encrypt(null), null)
  assert.equal(encrypt(undefined), null)
  assert.equal(decrypt(null), null)
  delete process.env.ENCRYPTION_KEY
})

test('decrypt of plaintext is a no-op (pass-through)', () => {
  process.env.ENCRYPTION_KEY = KEY
  assert.equal(decrypt('plaintext-not-tagged'), 'plaintext-not-tagged')
  delete process.env.ENCRYPTION_KEY
})

test('decrypt returns raw value on tamper / wrong key rather than throwing', () => {
  process.env.ENCRYPTION_KEY = KEY
  const ct = encrypt('data')!
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex') // different key
  assert.equal(decrypt(ct), ct) // does not throw, returns stored value
  delete process.env.ENCRYPTION_KEY
})

test('malformed key disables crypto (pass-through)', () => {
  process.env.ENCRYPTION_KEY = 'too-short'
  assert.equal(isCryptoEnabled(), false)
  assert.equal(encrypt('x'), 'x')
  delete process.env.ENCRYPTION_KEY
})
