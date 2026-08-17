/**
 * Data classification & masking policy — ISO 27001:2022 A.8.11 / A.5.12.
 *
 * Declares which columns are sensitive per table and how each should be treated when
 * serialized to a non-owner. This is a documentation/policy surface consumed by the
 * serializers in `src/security/serializers.ts`; the mechanical masking lives in `mask.ts`.
 */

export type Sensitivity = 'secret' | 'restricted' | 'internal'

export interface FieldPolicy {
  /** How the field is protected when returned to a caller that does not own the row. */
  strategy: 'strip' | 'partial' | 'deep-mask' | 'encrypt-at-rest'
  sensitivity: Sensitivity
  note?: string
}

/**
 * Per-table sensitive field policy. Owners (same org_id as the row) receive the
 * plaintext value; everyone else gets the masked/stripped form described here.
 */
export const SENSITIVE_FIELDS: Record<string, Record<string, FieldPolicy>> = {
  mcp_versions: {
    auth_header: {
      strategy: 'encrypt-at-rest',
      sensitivity: 'secret',
      note: 'Upstream credential for the publisher MCP. Encrypted at rest; stripped for public/non-owner reads.',
    },
  },
  tenant_subscriptions: {
    stripe_customer_id: { strategy: 'partial', sensitivity: 'restricted', note: 'Stripe customer id.' },
    stripe_subscription_id: { strategy: 'partial', sensitivity: 'restricted', note: 'Stripe subscription id.' },
  },
  usage_events: {
    caller_id: { strategy: 'partial', sensitivity: 'restricted', note: 'User id of the caller.' },
    meta: { strategy: 'deep-mask', sensitivity: 'internal', note: 'Free-form event metadata — deep-masked by key name.' },
  },
  agents: {
    system_prompt: { strategy: 'strip', sensitivity: 'restricted', note: 'Author IP; owner-only, stripped cross-org.' },
  },
  api_keys: {
    key_hash: { strategy: 'strip', sensitivity: 'secret', note: 'SHA-256 of the raw key; never serialized to clients.' },
  },
}

/** Convenience: the list of sensitive column names for a table. */
export function sensitiveColumns(table: string): string[] {
  return Object.keys(SENSITIVE_FIELDS[table] ?? {})
}
