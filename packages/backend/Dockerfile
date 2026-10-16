FROM node:20-slim

COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Copy workspace manifests for cache-efficient install
COPY package.json bun.lock ./
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/

# Skip browser download during bun install; we install explicitly below
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun install --frozen-lockfile --filter @picklescout/backend --filter @picklescout/shared

# Install Playwright's Chromium + all required system libraries.
# Version matches both Stagehand (peer >=1.52) and the generated tests (PINNED_PACKAGE_JSON).
RUN node packages/backend/node_modules/playwright-core/cli.js install chromium --with-deps

COPY packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy source after deps are cached
COPY packages/backend ./packages/backend
COPY packages/shared ./packages/shared

# Build shared first, then backend
RUN bun run --filter @picklescout/shared build
RUN bun run --filter @picklescout/backend build

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/backend/dist/index.js"]
