import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { encrypt } from './crypto'
import {
  serializeMcpVersion,
  serializeMcpVersions,
  serializeAgent,
  serializeTenantSubscription,
  serializeUsageEvent,
  isOwnerOf,
} from './serializers'
import type { McpVersionRecord } from '../repositories/mcp.repo'
import type { AgentRecord } from '../repositories/agent.repo'
import type { TenantSubscription } from '../repositories/billing.repo'
import type { UsageEvent } from '../repositories/usage.repo'

function makeVersion(auth_header: string | null): McpVersionRecord {
  return {
    id: 'v1', mcp_id: 'm1', version: '1.0.0', endpoint_url: 'https://x', schema_url: null,
    changelog: null, is_latest: true, transport_type: 'http', auth_header,
    published_by: 'u1', published_at: new Date(),
  }
}

test('isOwnerOf requires both orgs present and equal', () => {
  assert.equal(isOwnerOf('org-1', 'org-1'), true)
  assert.equal(isOwnerOf('org-1', 'org-2'), false)
  assert.equal(isOwnerOf(null, 'org-1'), false)
  assert.equal(isOwnerOf('org-1', null), false)
})

test('CRITICAL: non-owner/public mcp version serialization has NO auth_header', () => {
  const v = makeVersion('Bearer upstream-secret')
  const publicView = serializeMcpVersion(v, { isOwner: false, isAuthenticated: false }) as Record<string, unknown>
  assert.ok(!('auth_header' in publicView), 'auth_header must be stripped for public/non-owner')
  assert.equal(publicView.endpoint_url, 'https://x') // other fields retained
})

test('authenticated non-owner (marketplace consumer) still receives auth_header (shared token)', () => {
  const v = makeVersion('Bearer shared-token')
  const view = serializeMcpVersion(v, { isOwner: false, isAuthenticated: true }) as Record<string, unknown>
  assert.ok('auth_header' in view, 'an authenticated marketplace consumer must receive the shared connection token')
})

test('owner mcp version serialization includes auth_header (decrypted)', () => {
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex')
  const stored = encrypt('Bearer upstream-secret') // encrypted at rest
  const v = makeVersion(stored)
  const ownerView = serializeMcpVersion(v, { isOwner: true, isAuthenticated: true }) as Record<string, unknown>
  assert.ok('auth_header' in ownerView, 'owner must receive auth_header')
  assert.equal(ownerView.auth_header, 'Bearer upstream-secret') // decrypted back to plaintext
  delete process.env.ENCRYPTION_KEY
})

test('owner serialization passes through plaintext auth_header when crypto disabled', () => {
  delete process.env.ENCRYPTION_KEY
  const v = makeVersion('Bearer plain')
  const ownerView = serializeMcpVersion(v, { isOwner: true, isAuthenticated: true }) as Record<string, unknown>
  assert.equal(ownerView.auth_header, 'Bearer plain')
})

test('serializeMcpVersions maps a list and strips for non-owner', () => {
  const list = [makeVersion('a'), makeVersion('b')]
  const out = serializeMcpVersions(list, { isOwner: false, isAuthenticated: false })
  assert.equal(out.length, 2)
  for (const v of out) assert.ok(!('auth_header' in v))
})

test('agent system_prompt stripped cross-org, kept for owner', () => {
  const agent: AgentRecord = {
    id: 'a1', org_id: 'org-1', name: 'A', slug: 'a', description: null,
    system_prompt: 'secret prompt', model: 'gpt-4o', execution_mode: 'auto',
    mcp_ids: [], is_public: true, credit_cost: 0, created_by: 'u', created_at: new Date(), updated_at: new Date(),
  }
  const owner = serializeAgent(agent, { isOwner: true, isAuthenticated: true }) as Record<string, unknown>
  assert.equal(owner.system_prompt, 'secret prompt')
  const stranger = serializeAgent(agent, { isOwner: false, isAuthenticated: false }) as Record<string, unknown>
  assert.ok(!('system_prompt' in stranger))
})

test('tenant subscription stripe ids masked for non-owner, intact for owner', () => {
  const t: TenantSubscription = {
    id: 't1', org_id: 'org-1', stripe_customer_id: 'cus_ABCDEFGH', stripe_subscription_id: 'sub_ZYXWVUTS',
    plan: 'pro', status: 'active', mcp_limit: 100, api_calls_limit: 1000, current_period_end: null,
    created_at: new Date(), updated_at: new Date(),
  }
  assert.equal(serializeTenantSubscription(t, { isOwner: true, isAuthenticated: true }).stripe_customer_id, 'cus_ABCDEFGH')
  const masked = serializeTenantSubscription(t, { isOwner: false, isAuthenticated: false })
  assert.equal(masked.stripe_customer_id, '********EFGH')
  assert.equal(masked.stripe_subscription_id, '********VUTS')
})

test('usage event meta/caller_id masked for non-owner', () => {
  const e: UsageEvent = {
    id: 'e1', org_id: 'org-1', event_type: 'mcp_invoke', quantity: 1, resource_id: 'r',
    caller_id: 'user-abcdef', credits: '1', meta: { token: 'sk_live_x', note: 'ok' }, created_at: new Date(),
  }
  const owner = serializeUsageEvent(e, { isOwner: true, isAuthenticated: true })
  assert.equal(owner.caller_id, 'user-abcdef')
  assert.deepEqual(owner.meta, { token: 'sk_live_x', note: 'ok' })

  const masked = serializeUsageEvent(e, { isOwner: false, isAuthenticated: false })
  assert.equal(masked.caller_id, '*******cdef')
  assert.equal((masked.meta as Record<string, unknown>).token, '[REDACTED]')
  assert.equal((masked.meta as Record<string, unknown>).note, 'ok')
})
