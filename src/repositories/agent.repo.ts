import { getPool } from '../config/postgres'

export interface AgentRecord {
  id: string
  org_id: string
  name: string
  slug: string
  description: string | null
  system_prompt: string | null
  model: string
  execution_mode: 'auto' | 'step'
  mcp_ids: string[]
  is_public: boolean
  credit_cost: number
  created_by: string
  created_at: Date
  updated_at: Date
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function createAgent(opts: {
  org_id: string; name: string; description?: string; system_prompt?: string
  model?: string; execution_mode?: string; mcp_ids?: string[]; is_public?: boolean
  credit_cost?: number; created_by: string
}): Promise<AgentRecord> {
  const base = slugify(opts.name) + '-' + Math.random().toString(36).slice(2, 6)
  const { rows } = await getPool().query<AgentRecord>(
    `INSERT INTO agents (org_id, name, slug, description, system_prompt, model, execution_mode, mcp_ids, is_public, credit_cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [opts.org_id, opts.name, base, opts.description ?? null, opts.system_prompt ?? null,
     opts.model ?? 'gpt-4o', opts.execution_mode ?? 'auto', opts.mcp_ids ?? [],
     opts.is_public ?? true, opts.credit_cost ?? 0, opts.created_by],
  )
  return rows[0]
}

export async function listAgents(opts: { org_id?: string; public_only?: boolean; limit?: number; offset?: number }): Promise<AgentRecord[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.org_id)      { params.push(opts.org_id); conditions.push(`org_id = $${params.length}`) }
  if (opts.public_only) conditions.push('is_public = true')
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(opts.limit ?? 50, opts.offset ?? 0)
  const { rows } = await getPool().query<AgentRecord>(
    `SELECT * FROM agents ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return rows
}

export async function getAgentById(id: string): Promise<AgentRecord | null> {
  const { rows } = await getPool().query<AgentRecord>(`SELECT * FROM agents WHERE id = $1`, [id])
  return rows[0] ?? null
}

export async function updateAgent(id: string, org_id: string, patch: Partial<Pick<AgentRecord, 'name'|'description'|'system_prompt'|'model'|'execution_mode'|'mcp_ids'|'is_public'|'credit_cost'>>): Promise<AgentRecord | null> {
  const sets: string[] = ['updated_at = NOW()']
  const params: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    params.push(v); sets.push(`${k} = $${params.length}`)
  }
  params.push(id, org_id)
  const { rows } = await getPool().query<AgentRecord>(
    `UPDATE agents SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length} RETURNING *`,
    params,
  )
  return rows[0] ?? null
}

export async function deleteAgent(id: string, org_id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`DELETE FROM agents WHERE id = $1 AND org_id = $2`, [id, org_id])
  return (rowCount ?? 0) > 0
}
