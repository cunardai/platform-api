import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Request, Response } from 'express'
import { requireService, requirePlatformAdmin, requireOrgRole, callerOrgRole, BILLING_WRITE_SCOPE } from './authz'

type Caller = NonNullable<Request['caller']>

function run(mw: (req: Request, res: Response, next: () => void) => void, caller?: Partial<Caller>) {
  const req = { path: '/test', caller: caller as Caller | undefined } as Request
  const out: { status?: number; code?: string; passed: boolean } = { passed: false }
  const res = {
    status(s: number) { out.status = s; return this },
    json(b: { error?: { code?: string } }) { out.code = b.error?.code; return this },
  } as unknown as Response
  mw(req, res, () => { out.passed = true })
  return out
}

const jwt = (extra: Partial<Caller> = {}): Partial<Caller> =>
  ({ user_id: 'u1', org_id: 'org-a', scopes: [], via: 'jwt', ...extra })
const apiKey = (scopes: string[] = []): Partial<Caller> =>
  ({ user_id: 'u1', org_id: 'org-a', scopes, via: 'api_key' })
const service = (): Partial<Caller> =>
  ({ user_id: 'service', org_id: 'org-a', scopes: ['service'], via: 'service' })

// ── requireService: PA-1 / PA-2 ─────────────────────────────────────────────

test('requireService admits only the service credential', () => {
  assert.equal(run(requireService, service()).passed, true)
  for (const c of [jwt(), jwt({ org_role: 'owner' }), jwt({ is_platform_admin: true }), apiKey(['billing:write'])]) {
    const r = run(requireService, c)
    assert.equal(r.passed, false)
    assert.equal(r.status, 403)
    assert.equal(r.code, 'SERVICE_ONLY')
  }
})

test('requireService denies an anonymous caller', () => {
  const r = run(requireService, undefined)
  assert.equal(r.passed, false)
  assert.equal(r.status, 403)
})

// ── requirePlatformAdmin ────────────────────────────────────────────────────

test('requirePlatformAdmin needs the verified claim, not a role', () => {
  assert.equal(run(requirePlatformAdmin, jwt({ is_platform_admin: true })).passed, true)
  assert.equal(run(requirePlatformAdmin, service()).passed, true)
  assert.equal(run(requirePlatformAdmin, jwt({ org_role: 'owner' })).passed, false)
  assert.equal(run(requirePlatformAdmin, undefined).passed, false)
})

// ── requireOrgRole: PA-3 ────────────────────────────────────────────────────

const adminGate = requireOrgRole('admin', BILLING_WRITE_SCOPE)

test('a plain member cannot change billing config', () => {
  const r = run(adminGate, jwt({ org_role: 'member' }))
  assert.equal(r.passed, false)
  assert.equal(r.status, 403)
  assert.equal(r.code, 'FORBIDDEN')
})

test('an org admin and owner can', () => {
  assert.equal(run(adminGate, jwt({ org_role: 'admin' })).passed, true)
  assert.equal(run(adminGate, jwt({ org_role: 'owner' })).passed, true)
})

test('a token with NO org_role claim is denied, not defaulted', () => {
  // Tokens minted before auth-service sent the claim must not pass. This is
  // the fail-closed requirement: a missing claim is not a permissive one.
  const r = run(adminGate, jwt())
  assert.equal(r.passed, false)
  assert.equal(r.status, 403)
})

test('an unmodelled or malformed org_role claim is denied', () => {
  for (const bad of ['superuser', 'founder', 'OWNER', 'Admin', '', ' owner', 'owner ']) {
    const r = run(adminGate, jwt({ org_role: bad }))
    assert.equal(r.passed, false, `role claim ${JSON.stringify(bad)} must not pass`)
  }
  // A non-string claim must not throw or pass.
  for (const bad of [1, true, {}, ['owner']] as unknown[]) {
    assert.equal(run(adminGate, jwt({ org_role: bad as string })).passed, false)
  }
})

test('callerOrgRole never yields a rank for an unmodelled value', () => {
  assert.equal(callerOrgRole({ caller: { ...jwt({ org_role: 'founder' }) } } as Request), null)
  assert.equal(callerOrgRole({ caller: { ...jwt() } } as Request), null)
  assert.equal(callerOrgRole({} as Request), null)
  assert.equal(callerOrgRole({ caller: { ...jwt({ org_role: 'admin' }) } } as Request), 'admin')
})

test('an API key needs the named scope; an unscoped key is denied', () => {
  assert.equal(run(adminGate, apiKey(['billing:write'])).passed, true)
  assert.equal(run(adminGate, apiKey(['billing:write', 'other'])).passed, true)
  for (const scopes of [[], ['read'], ['billing'], ['billing:read']]) {
    const r = run(adminGate, apiKey(scopes))
    assert.equal(r.passed, false, `scopes ${JSON.stringify(scopes)} must not pass`)
    assert.equal(r.code, 'INSUFFICIENT_SCOPE')
  }
})

test('an API key cannot borrow an org_role claim', () => {
  // org_role is only meaningful on a user token; setting it on an API-key
  // caller must not open the role path.
  const r = run(adminGate, { ...apiKey([]), org_role: 'owner' })
  assert.equal(r.passed, false)
  assert.equal(r.code, 'INSUFFICIENT_SCOPE')
})

test('a service caller and a platform admin bypass the org-role gate', () => {
  assert.equal(run(adminGate, service()).passed, true)
  assert.equal(run(adminGate, jwt({ is_platform_admin: true })).passed, true)
})

test('requireOrgRole with no scope list refuses every API key', () => {
  const gate = requireOrgRole('admin')
  const r = run(gate, apiKey(['billing:write']))
  assert.equal(r.passed, false)
  assert.equal(r.code, 'INSUFFICIENT_SCOPE')
})

test('owner-level gates reject an admin', () => {
  const ownerGate = requireOrgRole('owner')
  assert.equal(run(ownerGate, jwt({ org_role: 'admin' })).passed, false)
  assert.equal(run(ownerGate, jwt({ org_role: 'owner' })).passed, true)
})
