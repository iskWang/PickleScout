FROM node:20-slim

RUN npm install -g pnpm

WORKDIR /app

# Copy workspace manifests for cache-efficient install
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/frontend/package.json ./packages/frontend/
COPY packages/backend/package.json ./packages/backend/
COPY packages/shared/package.json ./packages/shared/

# Skip browser download during pnpm install; we install explicitly below
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile --filter @picklescout/backend...

# Install Playwright's Chromium + all required system libraries.
# Version matches both Stagehand (peer >=1.52) and the generated tests (PINNED_PACKAGE_JSON).
RUN pnpm dlx playwright@1.60.0 install chromium --with-deps

COPY packages/backend/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Copy source after deps are cached
COPY packages/backend ./packages/backend
COPY packages/shared ./packages/shared

# Build shared first, then backend
RUN pnpm --filter @picklescout/shared build
RUN pnpm --filter @picklescout/backend build

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "packages/backend/dist/index.js"]
