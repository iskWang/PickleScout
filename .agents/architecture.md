# Architecture — PickleScout

## Two-Phase Design

PickleScout separates the **Generation** of tests from their **Execution**.

1.  **Phase 1: Generation (Web App)**
    *   **Goal**: Explore target URL and generate test code.
    *   **Workflow**: Frontend → Backend → Stagehand (LLM-driven) → Playwright/Chromium.
    *   **Output**: A standalone zip containing a Cucumber.js + Playwright project.
    *   **Note**: Stagehand and LLM are *only* used here.

2.  **Phase 2: Execution (CI/CD)**
    *   **Goal**: Run tests repeatedly in CI/CD (e.g., GitHub Actions).
    *   **Workflow**: Standard Playwright execution.
    *   **Note**: Zero LLM dependencies. Fully deterministic.

## Service Boundaries

- **Frontend**: React application for job submission and real-time monitoring via SSE.
- **Backend**: Fastify server managing the lifecycle of jobs, interacting with Redis and Stagehand.
- **Redis**: Stores job state, SSE event buffers, and manages the task queue (BullMQ).
- **Storage**: Persistent volume for screenshots, action logs, and generated artifacts.

## Data Flow

1.  **Submission**: User provides URL + LLM config.
2.  **Exploration**: Stagehand performs actions on the target site, recording an `ActionLog`.
3.  **Generation**: LLM processes `ActionLog` to produce Gherkin `.feature` and Playwright `.steps.ts`.
4.  **Verification**: The system runs the generated tests once to ensure they pass.
5.  **Packaging**: Result is zipped and made available for download.

## Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | React + Vite + TypeScript |
| Backend | Node.js + Fastify + TypeScript |
| Queue | BullMQ + Redis |
| Browser | Stagehand (Playwright wrapper) |
| Output | Cucumber.js + Playwright (pinned versions) |

## Agent Reference Docs

| Doc | Purpose |
|-----|---------|
| `architecture.md` | System design overview (this file) |
| `backend-style.md` | Backend coding conventions |
| `frontend-style.md` | Frontend coding conventions |
| `react-patterns.md` | React component patterns |
| `self-test.md` | End-to-end pipeline self-test — run after any worker/packager/template change |
| `specs/api-contract.md` | API contract |
| `specs/auth-flow.md` | Auth flow |
| `specs/state-management.md` | State machine |
