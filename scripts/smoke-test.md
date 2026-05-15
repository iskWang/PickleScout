# smoke-test.sh

Starts the full Docker stack, asserts `/health` responds, creates a job via `POST /api/jobs`, and confirms `GET /api/jobs/:hash` returns a status. Tears down on exit.

```
./scripts/smoke-test.sh
```

Requires Docker. Does not need a real LLM key — uses a placeholder that will fail the job eventually, but the API endpoints themselves are validated.
