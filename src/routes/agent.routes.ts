import { Router, Request, Response } from 'express'
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware'
import { createAgent, listAgents, getAgentById, updateAgent, deleteAgent } from '../repositories/agent.repo'
import { serializeAgent, isOwnerOf } from '../security/serializers'

const router = Router()

function orgId(req: Request): string | null {
  return req.caller?.org_id ?? null
}

// GET /agents — public browse
router.get('/', optionalAuthenticate, async (req: Request, res: Response) => {
  const { org, limit, offset } = req.query as Record<string, string | undefined>
  const agents = await listAgents({
    org_id: org,
    public_only: !org,
    limit: limit ? parseInt(limit, 10) : 50,
    offset: offset ? parseInt(offset, 10) : 0,
  })
  // system_prompt (author IP) is returned only for agents owned by the authenticated caller's org.
  const callerOrg = req.caller?.org_id
  return res.json({ success: true, data: agents.map((a) => serializeAgent(a, { isOwner: isOwnerOf(callerOrg, a.org_id), isAuthenticated: !!req.caller })) })
})

// GET /agents/:id
router.get('/:id', optionalAuthenticate, async (req: Request, res: Response) => {
  const agent = await getAgentById((req.params as { id: string }).id)
  if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } })
  const ctx = { isOwner: isOwnerOf(req.caller?.org_id, agent.org_id), isAuthenticated: !!req.caller }
  return res.json({ success: true, data: serializeAgent(agent, ctx) })
})

// POST /agents
router.post('/', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const { name, description, system_prompt, model, execution_mode, mcp_ids, is_public, credit_cost } = req.body as Record<string, unknown>
  if (!String(name ?? '').trim()) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } })
  const agent = await createAgent({
    org_id: org, name: String(name).trim(), description: description as string | undefined,
    system_prompt: system_prompt as string | undefined, model: model as string | undefined,
    execution_mode: execution_mode as string | undefined, mcp_ids: mcp_ids as string[] | undefined,
    is_public: is_public as boolean | undefined, credit_cost: credit_cost as number | undefined,
    created_by: req.caller!.user_id,
  })
  return res.status(201).json({ success: true, data: agent })
})

// PATCH /agents/:id
router.patch('/:id', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const { name, description, system_prompt, model, execution_mode, mcp_ids, is_public, credit_cost } = req.body as Record<string, unknown>
  const patch = Object.fromEntries(Object.entries({ name, description, system_prompt, model, execution_mode, mcp_ids, is_public, credit_cost }).filter(([,v]) => v !== undefined))
  const agent = await updateAgent((req.params as { id: string }).id, org, patch as never)
  if (!agent) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } })
  return res.json({ success: true, data: agent })
})

// DELETE /agents/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  const org = orgId(req)
  if (!org) return res.status(400).json({ success: false, error: { code: 'NO_ORG', message: 'org_id required' } })
  const deleted = await deleteAgent((req.params as { id: string }).id, org)
  if (!deleted) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Agent not found' } })
  return res.json({ success: true, data: { message: 'Agent deleted' } })
})

export default router
