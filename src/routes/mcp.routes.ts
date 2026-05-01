import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.middleware'
import { createMcp, listMcps, getMcpById, getMcpBySlug, updateMcp, deleteMcp, publishVersion, listVersions } from '../repositories/mcp.repo'
import { getOrCreateTenant, recordUsage } from '../repositories/billing.repo'
import { getPool } from '../config/postgres'

const router = Router()

function orgId(req: Request): string | null {
  return req.caller?.org_id ?? null
}

// ─── GET /mcps — public registry browse ──────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { org, limit, offset } = req.query as Record<string, string | undefined>
  const mcps = await listMcps({
    org_id: org,
    public_only: !org,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  })
  return res.json({ success: true, data: mcps })
})

// ─── GET /mcps/:idOrSlug ──────────────────────────────────────────────────────

router.get('/:idOrSlug', async (req: Request, res: Response) => {
  const { idOrSlug } = req.params as { idOrSlug: string }
  const mcp = idOrSlug.includes('-') && idOrSlug.length < 36
    ? await getMcpBySlug(idOrSlug)
    : (await getMcpById(idOrSlug)) ?? await getMcpBySlug(idOrSlug)
  if (!mcp) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'MCP not found' } })
  const versions = await listVersions(mcp.id)
  return res.json({ success: true, data: { ...mcp, versions } })
})

// ─── POST /mcps — register a new MCP ─────────────────────────────────────────

router.post('/', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required — authenticate with an API key that has an org' } })

  const { name, description, homepage_url, tags, is_public } = req.body as {
    name?: string; description?: string; homepage_url?: string; tags?: string[]; is_public?: boolean
  }
  if (!name?.trim()) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } })

  // Enforce plan MCP limit
  const tenant = await getOrCreateTenant(org)
  const { rows: [{ count }] } = await getPool().query<{ count: string }>(`SELECT COUNT(*) FROM mcps WHERE org_id = $1`, [org])
  if (parseInt(count, 10) >= tenant.mcp_limit) {
    return res.status(402).json({ success: false, error: { code: 'LIMIT_REACHED', message: `Your ${tenant.plan} plan allows ${tenant.mcp_limit} MCPs. Upgrade to publish more.` } })
  }

  const mcp = await createMcp({ org_id: org, name: name.trim(), description, homepage_url, tags, is_public, created_by: req.caller!.user_id })
  await recordUsage(org, 'mcp_created', { mcp_id: mcp.id })
  return res.status(201).json({ success: true, data: mcp })
})

// ─── PATCH /mcps/:id ──────────────────────────────────────────────────────────

router.patch('/:id', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const { name, description, homepage_url, tags, is_public } = req.body as Record<string, unknown>
  const patch = Object.fromEntries(Object.entries({ name, description, homepage_url, tags, is_public }).filter(([, v]) => v !== undefined))
  const mcp = await updateMcp((req.params as { id: string }).id, org, patch as never)
  if (!mcp) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'MCP not found' } })
  return res.json({ success: true, data: mcp })
})

// ─── DELETE /mcps/:id ─────────────────────────────────────────────────────────

router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const deleted = await deleteMcp((req.params as { id: string }).id, org)
  if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'MCP not found' } })
  return res.json({ success: true, data: { message: 'MCP deleted' } })
})

// ─── POST /mcps/:id/versions ──────────────────────────────────────────────────

router.post('/:id/versions', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const mcp = await getMcpById((req.params as { id: string }).id)
  if (!mcp || mcp.org_id !== org) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'MCP not found' } })

  const { version, endpoint_url, schema_url, changelog } = req.body as Record<string, string>
  if (!version || !endpoint_url) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'version and endpoint_url are required' } })

  const v = await publishVersion({ mcp_id: mcp.id, version, endpoint_url, schema_url, changelog, published_by: req.caller!.user_id })
  await recordUsage(org, 'mcp_version_published', { mcp_id: mcp.id, version })
  return res.status(201).json({ success: true, data: v })
})

// ─── GET /mcps/:id/versions ───────────────────────────────────────────────────

router.get('/:id/versions', async (req: Request, res: Response) => {
  const mcp = await getMcpById((req.params as { id: string }).id)
  if (!mcp) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'MCP not found' } })
  const versions = await listVersions(mcp.id)
  return res.json({ success: true, data: versions })
})

export default router
