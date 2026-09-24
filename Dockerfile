# syntax=docker/dockerfile:1

# --- build stage ---------------------------------------------------------
FROM node:25-alpine AS builder

WORKDIR /app

# Install with the lockfile so the image matches local development exactly.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Drop dev dependencies from the tree we are going to copy over.
RUN npm prune --omit=dev

# --- runtime stage -------------------------------------------------------
FROM node:25-alpine AS runtime

ENV NODE_ENV=production

WORKDIR /app

# node:alpine already ships an unprivileged "node" user.
COPY --chown=node:node package.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

# Liveness only — /ready is for the orchestrator, and neither touches OpenAI.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node handles SIGTERM itself; Nest's shutdown hooks close HTTP, Postgres and Redis.
CMD ["node", "dist/main.js"]
