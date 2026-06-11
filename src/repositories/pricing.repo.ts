import { getPool } from '../config/postgres'

// ── Pricing: per-model token rates + markup/credit-unit cascade ────────────────
//
// The caller (e.g. Schema Studio's backend) reports the facts of an AI call —
// model + token breakdown (input / output / cache-creation / cache-read). This
// module owns the *policy*: model rates, the universal cache-tier multipliers,
// the markup, and the dollar→credit conversion. Keeping pricing here means a
// provider price change or a markup tweak is a config edit in one place, never
// a code change in the consuming app.

export interface ModelRate {
  model: string
  input_per_mtok: string
  output_per_mtok: string
  cache_write_multiplier: string
  cache_read_multiplier: string
  updated_at: Date
}

export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_tokens?: number
  cache_read_tokens?: number
}

export interface PricingConfig {
  id: string
  org_id: string | null
  deployment_id: string | null
  markup: string
  credit_unit_usd: string
  description: string | null
  created_at: Date
  updated_at: Date
}

export interface CostBreakdown {
  model: string
  raw_cost_usd: number
  markup: number
  credit_unit_usd: number
  credits: number
  /** false when the model has no rate row — cost is 0 and the caller should be warned. */
  rate_found: boolean
}

const MTOK = 1_000_000

export async function getModelRate(model: string): Promise<ModelRate | null> {
  const { rows } = await getPool().query<ModelRate>(`SELECT * FROM model_rates WHERE model = $1`, [model])
  return rows[0] ?? null
}

export async function listModelRates(): Promise<ModelRate[]> {
  const { rows } = await getPool().query<ModelRate>(`SELECT * FROM model_rates ORDER BY model ASC`)
  return rows
}

export async function upsertModelRate(opts: {
  model: string
  input_per_mtok: number
  output_per_mtok?: number
  cache_write_multiplier?: number
  cache_read_multiplier?: number
}): Promise<ModelRate> {
  const { rows } = await getPool().query<ModelRate>(
    `INSERT INTO model_rates (model, input_per_mtok, output_per_mtok, cache_write_multiplier, cache_read_multiplier)
     VALUES ($1, $2, $3, COALESCE($4, 1.25), COALESCE($5, 0.10))
     ON CONFLICT (model) DO UPDATE SET
       input_per_mtok         = EXCLUDED.input_per_mtok,
       output_per_mtok        = EXCLUDED.output_per_mtok,
       cache_write_multiplier = COALESCE($4, model_rates.cache_write_multiplier),
       cache_read_multiplier  = COALESCE($5, model_rates.cache_read_multiplier),
       updated_at             = NOW()
     RETURNING *`,
    [opts.model, opts.input_per_mtok, opts.output_per_mtok ?? 0,
     opts.cache_write_multiplier ?? null, opts.cache_read_multiplier ?? null],
  )
  return rows[0]
}

/** Cache-aware raw cost in USD for one call. cache writes ~1.25× input, reads ~0.10×. */
export function computeRawCostUsd(rate: ModelRate, t: TokenUsage): number {
  const inRate  = parseFloat(rate.input_per_mtok)
  const outRate = parseFloat(rate.output_per_mtok)
  const cw      = parseFloat(rate.cache_write_multiplier)
  const cr      = parseFloat(rate.cache_read_multiplier)
  return (
    (t.input_tokens          ?? 0) / MTOK * inRate +
    (t.output_tokens         ?? 0) / MTOK * outRate +
    (t.cache_creation_tokens ?? 0) / MTOK * inRate * cw +
    (t.cache_read_tokens     ?? 0) / MTOK * inRate * cr
  )
}

/** Resolve markup + credit unit for a scope, most-specific first:
 *  (org, deployment) → (org, —) → (global). */
export async function resolvePricingConfig(org_id: string, deployment_id?: string | null): Promise<{ markup: number; credit_unit_usd: number }> {
  const dep = deployment_id ?? null
  const { rows } = await getPool().query<PricingConfig>(
    `SELECT * FROM pricing_config
      WHERE (org_id = $1 AND deployment_id = $2)
         OR (org_id = $1 AND deployment_id IS NULL)
         OR (org_id IS NULL AND deployment_id IS NULL)
      ORDER BY (deployment_id IS NOT NULL) DESC, (org_id IS NOT NULL) DESC
      LIMIT 1`,
    [org_id, dep],
  )
  const cfg = rows[0]
  // Hard fallback if 006's global-default seed somehow isn't present.
  if (!cfg) return { markup: 1.4, credit_unit_usd: 0.01 }
  return { markup: parseFloat(cfg.markup), credit_unit_usd: parseFloat(cfg.credit_unit_usd) }
}

export async function listPricingConfig(org_id: string): Promise<PricingConfig[]> {
  const { rows } = await getPool().query<PricingConfig>(
    `SELECT * FROM pricing_config
      WHERE org_id = $1 OR org_id IS NULL
      ORDER BY (org_id IS NOT NULL) DESC, (deployment_id IS NOT NULL) DESC`,
    [org_id],
  )
  return rows
}

export async function upsertPricingConfig(opts: {
  org_id: string | null
  deployment_id?: string | null
  markup: number
  credit_unit_usd?: number
  description?: string
}): Promise<PricingConfig> {
  const { rows } = await getPool().query<PricingConfig>(
    `INSERT INTO pricing_config (org_id, deployment_id, markup, credit_unit_usd, description)
     VALUES ($1, $2, $3, COALESCE($4, 0.01), $5)
     ON CONFLICT ((COALESCE(org_id, '')), (COALESCE(deployment_id, ''))) DO UPDATE SET
       markup          = EXCLUDED.markup,
       credit_unit_usd = EXCLUDED.credit_unit_usd,
       description     = EXCLUDED.description,
       updated_at      = NOW()
     RETURNING *`,
    [opts.org_id, opts.deployment_id ?? null, opts.markup, opts.credit_unit_usd ?? null, opts.description ?? null],
  )
  return rows[0]
}

/** Full pricing for one call: raw cost → marked-up → credits (ceil to credit unit).
 *  markup = 0 (BYO-LLM) yields credits = 0 while still reporting raw_cost_usd. */
export async function computeCredits(opts: {
  org_id: string
  deployment_id?: string | null
  model: string
  tokens: TokenUsage
}): Promise<CostBreakdown> {
  const [rate, cfg] = await Promise.all([
    getModelRate(opts.model),
    resolvePricingConfig(opts.org_id, opts.deployment_id),
  ])
  const raw_cost_usd = rate ? computeRawCostUsd(rate, opts.tokens) : 0
  const credits = cfg.markup > 0 && cfg.credit_unit_usd > 0
    ? Math.ceil((raw_cost_usd * cfg.markup) / cfg.credit_unit_usd)
    : 0
  return {
    model: opts.model,
    raw_cost_usd,
    markup: cfg.markup,
    credit_unit_usd: cfg.credit_unit_usd,
    credits,
    rate_found: rate != null,
  }
}
