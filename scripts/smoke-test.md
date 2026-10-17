# smoke-test.sh

Starts the full Docker stack, asserts `/health` responds, creates a job via `POST /api/jobs`, and confirms `GET /api/jobs/:hash` returns a status. Tears down on exit.

```
./scripts/smoke-test.sh
```

Runs in its own Compose project (`picklescout-smoke`) on host ports 3199/5199 (override with `SMOKE_BACKEND_PORT` / `SMOKE_FRONTEND_PORT`), so `down -v` only removes the smoke stack's volumes and never touches a running dev stack. Requires Docker. Does not need a real LLM key — uses a placeholder that will fail the job eventually, but the API endpoints themselves are validated.
