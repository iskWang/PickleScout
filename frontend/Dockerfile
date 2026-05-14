FROM node:20-slim AS builder

RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY . .

# VITE_API_URL must be a build-time ARG (Vite bakes env vars into the bundle)
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=$VITE_API_URL

RUN pnpm build

# Serve with a lightweight HTTP server
FROM node:20-slim
RUN npm install -g serve

WORKDIR /app
COPY --from=builder /app/dist ./dist

EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
