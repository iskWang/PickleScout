FROM node:20-slim AS builder

RUN npm install -g pnpm

WORKDIR /app

# Copy workspace manifests for cache-efficient install
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/

# Install frontend + its workspace deps (includes @picklescout/shared)
RUN pnpm install --frozen-lockfile --filter @picklescout/frontend...

# Copy source after deps are cached
COPY packages/frontend ./packages/frontend
COPY packages/shared ./packages/shared

# Build shared first, then frontend
RUN pnpm --filter @picklescout/shared build
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL
RUN pnpm --filter @picklescout/frontend build

# Serve with a lightweight HTTP server
FROM node:20-slim
RUN npm install -g serve

WORKDIR /app
COPY --from=builder /app/packages/frontend/dist ./dist

EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
