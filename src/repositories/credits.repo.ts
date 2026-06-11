import { getPool } from '../config/postgres'
import { computeCredits, TokenUsage } from './pricing.repo'

// ── Credit balance + ledger ────────────────────────────────────────────────────
//
// Balance is per (org_id, deployment_id); deployment_id '' is the org-level
// (no-deployment) balance. A MISSING balance row means "not provisioned" →
// enforcement is off (treated as unlimited). Enforcement is opt-in: grant a
// balance and `check` starts gating against it. `charge` always records the
// usage event (the ledger truth) and decrements the balance if one exists —
// overage is allowed to go negative so the record stays accurate; the pre-call
// `check` is what prevents overspend.

function normDeployment(deployment_id?: string | null): string {
  return deployment_id ?? ''
}

export interface Balance {
  org_id: string
  deployment_id: string
  balance: number
  provisioned: boolean
}

export async function getBalance(org_id: string, deployment_id?: string | null): Promise<Balance> {
  const dep = normDeployment(deployment_id)
  const { rows } = await getPool().query<{ balance: string }>(
    `SELECT balance FROM credit_balances WHERE org_id = $1 AND deployment_id = $2`,
    [org_id, dep],
  )
  return {
    org_id,
    deployment_id: dep,
    balance: rows[0] ? parseFloat(rows[0].balance) : 0,
    provisioned: rows.length > 0,
  }
}

/** Add (or, with a negative amount, remove) credits. Upserts the balance row,
 *  which also turns enforcement ON for this scope. */
export async function grantCredits(org_id: string, amount: number, deployment_id?: string | null): Promise<Balance> {
  const dep = normDeployment(deployment_id)
  const { rows } = await getPool().query<{ balance: string }>(
    `INSERT INTO credit_balances (org_id, deployment_id, balance)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, deployment_id) DO UPDATE
       SET balance = credit_balances.balance + EXCLUDED.balance, updated_at = NOW()
     RETURNING balance`,
    [org_id, dep, amount],
  )
  return { org_id, deployment_id: dep, balance: parseFloat(rows[0].balance), provisioned: true }
}

export interface ChargeResult {
  event_id: string
  model: string
  credits: number
  raw_cost_usd: number
  markup: number
  rate_found: boolean
  /** balance after the charge, or null when the scope isn't provisioned (unenforced). */
  balance: number | null
  provisioned: boolean
}

/** Price the call, record a usage_event with the full token breakdown, and
 *  decrement the balance — all in one transaction. */
export async function chargeCredits(opts: {
  org_id: string
  deployment_id?: string | null
  feature: string                 // becomes usage_events.event_type, e.g. "ai.generate_bqs"
  model: string
  tokens: TokenUsage
  resource_id?: string
  caller_id?: string
  client_id?: string
  meta?: Record<string, unknown>
}): Promise<ChargeResult> {
  const dep = normDeployment(opts.deployment_id)
  const cost = await computeCredits({
    org_id: opts.org_id, deployment_id: opts.deployment_id, model: opts.model, tokens: opts.tokens,
  })

  const client = await getPool().connect()
  try {
    await client.query('BEGIN')

    // Decrement only if the scope is provisioned (row exists). Overage allowed.
    const { rows: balRows } = await client.query<{ balance: string }>(
      `UPDATE credit_balances SET balance = balance - $3, updated_at = NOW()
       WHERE org_id = $1 AND deployment_id = $2
       RETURNING balance`,
      [opts.org_id, dep, cost.credits],
    )

    const { rows: evtRows } = await client.query<{ id: string }>(
      `INSERT INTO usage_events
         (org_id, event_type, quantity, resource_id, caller_id, credits, meta, client_id,
          model, deployment_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, raw_cost_usd)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING id`,
      [
        opts.org_id, opts.feature, 1, opts.resource_id ?? null, opts.caller_id ?? null,
        cost.credits, opts.meta ? JSON.stringify(opts.meta) : null, opts.client_id ?? null,
        opts.model, dep,
        opts.tokens.input_tokens ?? null, opts.tokens.output_tokens ?? null,
        opts.tokens.cache_creation_tokens ?? null, opts.tokens.cache_read_tokens ?? null,
        cost.raw_cost_usd,
      ],
    )

    await client.query('COMMIT')

    return {
      event_id: evtRows[0].id,
      model: cost.model,
      credits: cost.credits,
      raw_cost_usd: cost.raw_cost_usd,
      markup: cost.markup,
      rate_found: cost.rate_found,
      balance: balRows[0] ? parseFloat(balRows[0].balance) : null,
      provisioned: balRows.length > 0,
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
