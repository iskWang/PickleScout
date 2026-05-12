# PickleScout — Agent Context

LLM-driven browser agent → Cucumber.js + Playwright test projects.
Architecture overview: .agents/architecture.md

## Stack
- Frontend: React 18, Vite 5, TypeScript 5.5
- Backend: Node.js 20, TypeScript 5.5, Fastify 4
- Browser: Stagehand v3 (Chromium only)
- Queue: Redis 7 + bullmq 5
- Output: Cucumber.js 11.0.0 + Playwright 1.50.0 (exact-pinned)

## Commands
```bash
docker compose up             # start all services
cd frontend && pnpm dev       # Vite dev server
cd backend && pnpm dev        # ts-node-dev watch

pnpm lint                     # ESLint
pnpm typecheck                # tsc --noEmit (run before committing)
pnpm test                     # unit tests
```

## Absolute Constraints
- NEVER log apiKey, password, cookie, or authorization — always call safeLog() first
- Stagehand is generation-only; output artifacts NEVER import Stagehand or any LLM SDK
- Chromium only — no Firefox or WebKit code paths
- Pinned versions in generated output package.json MUST NOT use ^ or ~ prefixes
- Redis keys MUST follow the job:{hash} prefix convention

## Boundaries
Always (no confirmation needed):
- Read files, list directories
- Run lint / typecheck on a single file
- Run a single unit test

Ask first:
- pnpm add / pnpm install or adding any dependency
- docker compose up / down / restart
- Any Redis data deletion

Never:
- Modify /storage without a job context
- Add Stagehand or LLM SDK imports to frontend/
- Run Redis FLUSHALL

## Detailed Docs
- Architecture:      .agents/architecture.md
- Frontend style:    .agents/frontend-style.md
- Backend style:     .agents/backend-style.md
- React patterns:    .agents/react-patterns.md
- API contract:      .agents/specs/api-contract.md
- State machine:     .agents/specs/state-management.md
- Auth flow:         .agents/specs/auth-flow.md
