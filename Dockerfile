FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY openapi.json ./

# Migrations, and note WHERE: db/migrate.js resolves them as
# `__dirname/../../migrations`, and with rootDir "." the emit puts that file at
# dist/src/db/ — so the folder has to sit inside dist/, not at the repo root.
# A provisioned install has no separate `npm run migrate` step, so without this
# the container comes up against an empty database and fails every request.
COPY migrations ./dist/migrations

# Drop root: the node images ship an unprivileged `node` user (uid 1000). The
# service only reads from /app at runtime, so ownership is sufficient.
RUN chown -R node:node /app
USER node

EXPOSE 3004

# Liveness only — /health always answers 200 when the process is serving, and we
# accept ANY HTTP reply so a dependency blip can't mark the container unhealthy
# and trigger restarts. Uses the node binary already present (no extra package).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3004/health',r=>process.exit(0)).on('error',()=>process.exit(1))"

# Migrate, then serve. Separate processes on purpose: migrate.ts calls
# pool.end() when it finishes, which would close the pool the server needs.
# Idempotent — already-applied files are skipped — so a restart costs nothing.
CMD ["sh", "-c", "node dist/src/db/migrate.js && node dist/src/index.js"]
