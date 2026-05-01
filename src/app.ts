import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import { errorHandler } from './middleware/auth.middleware'
import mcpRoutes from './routes/mcp.routes'
import billingRoutes from './routes/billing.routes'

export const app = express()

app.set('trust proxy', 1)
app.use(helmet())
app.use(cors({ origin: true, credentials: true }))
app.use(morgan('combined'))

// Raw body needed for Stripe webhook signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'platform-api', timestamp: new Date().toISOString() })
})

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/mcps', mcpRoutes)
app.use('/billing', billingRoutes)

// ─── 404 + error handler ──────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } })
})

app.use(errorHandler as express.ErrorRequestHandler)
