# PickleScout — Agent Context

LLM-driven browser agent → Cucumber.js + Playwright test projects.
Architecture overview: .agents/architecture.md

## Stack
- Frontend: React 18, Vite 5, TypeScript 5.5
- Backend: Node.js 20, TypeScript 5.5, Fastify 4
- Browser: Stagehand v3 (Chromium only)
- Queue: Redis 7 + bullmq 5
- Output: Cucumber.js 11.0.0 + Playwright 1.60.0 (exact-pinned)

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

## Job Error Investigation Protocol
When a job error is reported, the Agent MUST proactively check ALL of the following — do NOT wait to be asked:

1. **Action log** (`/storage/action-logs/{hash}.json`): selectors, entry types, XPath presence
2. **Intent spec** (`/storage/generated/{hash}/intent-spec.json`): templateIds used, param values, scenario structure
3. **Feature files** (`/storage/generated/{hash}/features/*.feature`):
   - Every step has a matching step definition (no unmatched patterns)
   - At least one `Then` assertion per scenario (not pure navigation/click chains)
   - No hallucinated URLs that don't plausibly exist on the target site
4. **Step file** (`/storage/generated/{hash}/steps/steps.ts`):
   - Implementation matches the template catalog (no self-healer rewrites — no hardcoded `baseUrl`, `waitUntil`, etc.)
   - No XPath (`/html[`, `xpath=`) in any locator call
   - No `document.`, `window.`, `HTMLElement` references
5. **TypeScript**: Run `tsc --noEmit` in the generated project dir to confirm it compiles
6. **Step pattern matching**: Every Gherkin step in every `.feature` maps to a `Given/When/Then(...)` in `steps.ts`

Any gap found MUST be fixed and covered by a unit test before the fix is considered complete.

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
