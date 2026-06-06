# platform-api — production image (Azure Container Apps)
#
# Multi-stage: compile TS -> dist in a builder, ship a slim runtime with prod
# deps + dist + the SQL migrations the migrate step reads at runtime.
#
# Build layout note: tsconfig has rootDir "." and include ["src","api"], so the
# compiler emits dist/src/** and dist/api/** (NOT dist/index.js). The real entry
# is dist/src/index.js; the migrate script is dist/src/db/migrate.js and resolves
# its SQL via path.join(__dirname, "../../migrations") => dist/migrations.
# (The package.json "start" script points at dist/index.js and is stale — it was
# only ever used by the Vercel api/index.ts handler, never `npm start`.)
#
# platform-api does NOT migrate on boot. Run migrations as a one-shot Container
# Apps Job: node dist/src/db/migrate.js (idempotent — tracks applied files).

# ── builder ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY api ./api
RUN npm run build

# ── runtime ───────────────────────────────────────────────────────────
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3004
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# migrate.js resolves migrations at dist/migrations (see note above)
COPY migrations ./dist/migrations
EXPOSE 3004
CMD ["node", "dist/src/index.js"]
