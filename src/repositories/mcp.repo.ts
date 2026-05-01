import { getPool } from '../config/postgres'

export interface McpRecord {
  id: string
  org_id: string
  name: string
  slug: string
  description: string | null
  homepage_url: string | null
  tags: string[]
  is_public: boolean
  is_verified: boolean
  credit_cost_per_call: number
  created_by: string
  created_at: Date
  updated_at: Date
}

export interface McpVersionRecord {
  id: string
  mcp_id: string
  version: string
  endpoint_url: string
  schema_url: string | null
  changelog: string | null
  is_latest: boolean
  published_by: string
  published_at: Date
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export async function createMcp(opts: {
  org_id: string; name: string; description?: string
  homepage_url?: string; tags?: string[]; is_public?: boolean
  credit_cost_per_call?: number; created_by: string
}): Promise<McpRecord> {
  const slug = slugify(opts.name) + '-' + Math.random().toString(36).slice(2, 6)
  const { rows } = await getPool().query<McpRecord>(
    `INSERT INTO mcps (org_id, name, slug, description, homepage_url, tags, is_public, credit_cost_per_call, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [opts.org_id, opts.name, slug, opts.description ?? null, opts.homepage_url ?? null,
     opts.tags ?? [], opts.is_public ?? true, opts.credit_cost_per_call ?? 0, opts.created_by],
  )
  return rows[0]
}

export async function listMcps(opts: { org_id?: string; public_only?: boolean; limit?: number; offset?: number }): Promise<McpRecord[]> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (opts.org_id)      { params.push(opts.org_id);  conditions.push(`org_id = $${params.length}`) }
  if (opts.public_only) conditions.push('is_public = true')
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  params.push(opts.limit ?? 50, opts.offset ?? 0)
  const { rows } = await getPool().query<McpRecord>(
    `SELECT * FROM mcps ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  )
  return rows
}

export async function getMcpBySlug(slug: string): Promise<McpRecord | null> {
  const { rows } = await getPool().query<McpRecord>(`SELECT * FROM mcps WHERE slug = $1`, [slug])
  return rows[0] ?? null
}

export async function getMcpById(id: string): Promise<McpRecord | null> {
  const { rows } = await getPool().query<McpRecord>(`SELECT * FROM mcps WHERE id = $1`, [id])
  return rows[0] ?? null
}

export async function updateMcp(id: string, org_id: string, patch: Partial<Pick<McpRecord, 'name' | 'description' | 'homepage_url' | 'tags' | 'is_public'>>): Promise<McpRecord | null> {
  const sets: string[] = ['updated_at = NOW()']
  const params: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    params.push(v)
    sets.push(`${k} = $${params.length}`)
  }
  params.push(id, org_id)
  const { rows } = await getPool().query<McpRecord>(
    `UPDATE mcps SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND org_id = $${params.length} RETURNING *`,
    params,
  )
  return rows[0] ?? null
}

export async function deleteMcp(id: string, org_id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(`DELETE FROM mcps WHERE id = $1 AND org_id = $2`, [id, org_id])
  return (rowCount ?? 0) > 0
}

export async function publishVersion(opts: {
  mcp_id: string; version: string; endpoint_url: string
  schema_url?: string; changelog?: string; published_by: string
}): Promise<McpVersionRecord> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(`UPDATE mcp_versions SET is_latest = false WHERE mcp_id = $1`, [opts.mcp_id])
    const { rows } = await client.query<McpVersionRecord>(
      `INSERT INTO mcp_versions (mcp_id, version, endpoint_url, schema_url, changelog, is_latest, published_by)
       VALUES ($1,$2,$3,$4,$5,true,$6) RETURNING *`,
      [opts.mcp_id, opts.version, opts.endpoint_url, opts.schema_url ?? null, opts.changelog ?? null, opts.published_by],
    )
    await client.query(`UPDATE mcps SET updated_at = NOW() WHERE id = $1`, [opts.mcp_id])
    await client.query('COMMIT')
    return rows[0]
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function listVersions(mcp_id: string): Promise<McpVersionRecord[]> {
  const { rows } = await getPool().query<McpVersionRecord>(
    `SELECT * FROM mcp_versions WHERE mcp_id = $1 ORDER BY published_at DESC`,
    [mcp_id],
  )
  return rows
}
