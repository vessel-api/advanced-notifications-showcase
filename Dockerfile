# Multi-stage build: a dedicated geo-build layer caches the Europe/Amsterdam
# polygon JSON (slow turf computation) and a final runtime layer drops the
# build tooling.

# ---------- Stage 1: build geo ----------
FROM node:20-alpine AS geo
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY scripts/build-geo.js ./scripts/build-geo.js
RUN mkdir -p client/src/geo && node scripts/build-geo.js

# ---------- Stage 2: runtime ----------
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=development
# Vite is loaded via createServer() at request time from the dependency tree, so
# we need the full (dev) install in the runtime image. The image stays around
# 220 MB which is fine for a showcase distribution.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY server ./server
COPY scripts ./scripts
COPY client ./client
COPY vite.config.js ./vite.config.js
# Pre-built geo from Stage 1 (saves ~20s of turf union/buffer on every start).
COPY --from=geo /app/client/src/geo ./client/src/geo

EXPOSE 3001
CMD ["node", "server/index.js"]
