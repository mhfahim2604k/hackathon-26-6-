# syntax=docker/dockerfile:1.6

# ---------- Stage 1: deps ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Copy only manifests first for cache reuse.
COPY package.json package-lock.json ./

# Install production + dev deps (needed for `tsc` build in next stage).
RUN npm ci --no-audit --no-fund

# ---------- Stage 2: build ----------
FROM node:20-alpine AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Type-check and emit compiled JS to dist/.
RUN npm run build

# Strip dev deps for the runtime image.
RUN npm prune --omit=dev

# ---------- Stage 3: runtime ----------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8000

# Run as non-root for least privilege.
RUN addgroup -S app && adduser -S app -G app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app

EXPOSE 8000

# Bind to 0.0.0.0 so the container is reachable from outside the container network.
CMD ["node", "dist/server.js"]