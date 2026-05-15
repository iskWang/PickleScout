FROM node:20-slim

RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./

# Skip browser download during pnpm install; we install explicitly below
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm install --frozen-lockfile

# Install Playwright's Chromium + all required system libraries
RUN pnpm dlx playwright@1.60.0 install chromium --with-deps

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY . .
RUN pnpm build

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
