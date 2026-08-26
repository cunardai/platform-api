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

CMD ["node", "dist/src/index.js"]
