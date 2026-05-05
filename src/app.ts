import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import fs from 'fs'
import path from 'path'
import { errorHandler } from './middleware/auth.middleware'
import mcpRoutes from './routes/mcp.routes'
import billingRoutes from './routes/billing.routes'
import usageRoutes from './routes/usage.routes'

export const app = express()

app.set('trust proxy', 1)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      workerSrc: ["'self'", 'blob:'],
    },
  },
}))
app.use(cors({ origin: true, credentials: true }))
app.use(morgan('combined'))

// Raw body needed for Stripe webhook signature verification
app.use('/billing/webhook', express.raw({ type: 'application/json' }))
app.use(express.json())

// ─── Health ───────────────────────────────────────────────────────────────────

app.get('/', (_req, res) => res.redirect(301, '/docs'))

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'platform-api', timestamp: new Date().toISOString() })
})

// ─── Docs ─────────────────────────────────────────────────────────────────────

const openapiPath = path.join(process.cwd(), 'openapi.json')
if (fs.existsSync(openapiPath)) {
  const spec = JSON.parse(fs.readFileSync(openapiPath, 'utf-8')) as object
  app.get('/docs.json', (_req, res) => res.json(spec))
  app.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Platform API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body { margin: 0; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js"></script>
<script>
window.onload = function() {
  SwaggerUIBundle({
    url: '/docs.json',
    dom_id: '#swagger-ui',
    presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
    plugins: [SwaggerUIBundle.plugins.DownloadUrl],
    layout: 'StandaloneLayout',
    deepLinking: true,
  })
}
</script>
</body>
</html>`)
  })
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use('/mcps', mcpRoutes)
app.use('/billing', billingRoutes)
app.use('/usage', usageRoutes)

// ─── 404 + error handler ──────────────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } })
})

app.use(errorHandler as express.ErrorRequestHandler)
