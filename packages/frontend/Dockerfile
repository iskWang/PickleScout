FROM node:20-slim AS builder

COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy workspace manifests for cache-efficient install
COPY package.json bun.lock ./
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/

# Install frontend + its workspace deps (includes @picklescout/shared)
RUN bun install --frozen-lockfile --filter @picklescout/frontend --filter @picklescout/shared

# Copy source after deps are cached
COPY packages/frontend ./packages/frontend
COPY packages/shared ./packages/shared

# Build shared first, then frontend
RUN bun run --filter @picklescout/shared build
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN bun run --filter @picklescout/frontend build

# Serve with a lightweight HTTP server
FROM node:20-slim
RUN npm install -g serve

WORKDIR /app
COPY --from=builder /app/packages/frontend/dist ./dist

EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
