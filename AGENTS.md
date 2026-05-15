# PickleScout — Agent Context

LLM-driven browser agent → Cucumber.js + Playwright test projects.
Architecture overview: .agents/architecture.md

## Stack
- Frontend: React 18, Vite 5, TypeScript 5.5
- Backend: Node.js 20, TypeScript 5.5, Fastify 4
- Browser: Stagehand v3 (Chromium only)
- Queue: Redis 7 + bullmq 5
- Output: Cucumber.js 11.0.0 + Playwright 1.50.0 (exact-pinned)

## Monorepo layout

```
packages/
  shared/    # @picklescout/shared — types used by both frontend and backend
  frontend/  # @picklescout/frontend — React + Vite
  backend/   # @picklescout/backend — Fastify + Stagehand + BullMQ
```

Shared types live in `packages/shared/src/types.ts` — modify there, never duplicate in frontend or backend.

## Commands
```bash
docker compose up                        # start all services
pnpm dev:frontend                        # Vite dev server (packages/frontend)
pnpm dev:backend                         # ts-node-dev watch (packages/backend)

pnpm -r typecheck                        # typecheck all workspaces
pnpm -r lint                             # lint all workspaces
pnpm -r test                             # unit tests all workspaces
pnpm --filter @picklescout/shared build  # build shared types (required before typecheck)
```

## Absolute Constraints
- NEVER log apiKey, password, cookie, or authorization — always call safeLog() first
- Stagehand is generation-only; output artifacts NEVER import Stagehand or any LLM SDK
- Chromium only — no Firefox or WebKit code paths
- Pinned versions in generated output package.json MUST NOT use ^ or ~ prefixes
- Redis keys MUST follow the job:{hash} prefix convention
- PRD Alignment: Field names and event types MUST strictly match `docs/PRD.md`
- Browser Hygiene: Every Stagehand/Playwright instance MUST be explicitly closed in a `finally` block to prevent resource leaks

## Definition of Done
Before declaring a task complete, the Agent MUST:
1. **Typecheck**: Run `pnpm -r typecheck` and resolve all errors.
2. **Lint**: Run `pnpm -r lint` and ensure no styling or rule violations remain.
3. **Tests**: Run `pnpm -r test` and ensure all tests pass (no regressions).
4. **PRD Sync**: Verify that any new fields or logic strictly follow `docs/PRD.md`.
5. **Hygiene**: Ensure all temporary files or test artifacts are cleaned up.

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
