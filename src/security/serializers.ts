/**
 * Response serializers — enforce A.8.11 masking at the API boundary.
 *
 * Each serializer takes a DB row plus a {@link SerializeCtx} describing whether the
 * caller owns the row (same org_id). Owners receive the full/decrypted value; public
 * and cross-org callers receive a stripped or masked form.
 *
 * These are the single place secret columns are allowed to leave the service, replacing
 * the previous `SELECT *` → JSON pass-through that leaked `auth_header` publicly.
 */
import { decrypt } from './crypto'
import { maskPartial, deepMaskObject } from './masking/mask'
import type { McpVersionRecord } from '../repositories/mcp.repo'
import type { AgentRecord } from '../repositories/agent.repo'
import type { TenantSubscription } from '../repositories/billing.repo'
import type { UsageEvent } from '../repositories/usage.repo'

export interface SerializeCtx {
  /** True when the caller's org_id matches the row's org_id. */
  isOwner: boolean
  /** True when the request carries a valid API key / JWT (any authenticated caller). */
  isAuthenticated: boolean
}

/** Derive ownership from the authenticated caller (if any) and the row's org. */
export function isOwnerOf(callerOrgId: string | null | undefined, rowOrgId: string | null | undefined): boolean {
  return !!callerOrgId && !!rowOrgId && callerOrgId === rowOrgId
}

// ─── MCP versions ─────────────────────────────────────────────────────────────

export type SerializedMcpVersion = Omit<McpVersionRecord, 'auth_header'> & { auth_header?: string | null }

/**
 * `auth_header` is the SHARED connection token marketplace consumers need to reach the
 * published MCP endpoint — so it's returned (decrypted) to any AUTHENTICATED caller
 * (valid API key / JWT). Anonymous/public callers get it stripped entirely (this closes
 * the original unauthenticated-public leak without breaking authenticated installs).
 */
export function serializeMcpVersion(v: McpVersionRecord, ctx: SerializeCtx): SerializedMcpVersion {
  if (!ctx.isAuthenticated) {
    const { auth_header: _stripped, ...rest } = v
    return rest
  }
  return { ...v, auth_header: decrypt(v.auth_header) }
}

export function serializeMcpVersions(list: McpVersionRecord[], ctx: SerializeCtx): SerializedMcpVersion[] {
  return list.map((v) => serializeMcpVersion(v, ctx))
}

// ─── Agents ────────────────────────────────────────────────────────────────────

export type SerializedAgent = AgentRecord | Omit<AgentRecord, 'system_prompt'>

/** Authenticated marketplace consumers need `system_prompt` to run the agent, so any
 *  authenticated caller keeps it; anonymous/public callers get it stripped (author IP). */
export function serializeAgent(a: AgentRecord, ctx: SerializeCtx): SerializedAgent {
  if (ctx.isAuthenticated) return a
  const { system_prompt: _stripped, ...rest } = a
  return rest
}

export function serializeAgents(list: AgentRecord[], ctx: SerializeCtx): SerializedAgent[] {
  return list.map((a) => serializeAgent(a, ctx))
}

// ─── Tenant subscription ─────────────────────────────────────────────────────

export function serializeTenantSubscription(t: TenantSubscription, ctx: SerializeCtx): TenantSubscription {
  if (ctx.isOwner) return t
  return {
    ...t,
    stripe_customer_id: t.stripe_customer_id ? maskPartial(t.stripe_customer_id, 4) : t.stripe_customer_id,
    stripe_subscription_id: t.stripe_subscription_id ? maskPartial(t.stripe_subscription_id, 4) : t.stripe_subscription_id,
  }
}

// ─── Usage events ────────────────────────────────────────────────────────────

export function serializeUsageEvent(e: UsageEvent, ctx: SerializeCtx): UsageEvent {
  if (ctx.isOwner) return e
  return {
    ...e,
    caller_id: e.caller_id ? maskPartial(e.caller_id, 4) : e.caller_id,
    meta: e.meta ? (deepMaskObject(e.meta) as Record<string, unknown>) : e.meta,
  }
}

export function serializeUsageEvents(list: UsageEvent[], ctx: SerializeCtx): UsageEvent[] {
  return list.map((e) => serializeUsageEvent(e, ctx))
}
