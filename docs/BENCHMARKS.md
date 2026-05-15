# PickleScout — Concurrency Benchmarks

> Target machine: Mac Mini (Apple M-series, 16 GB RAM)
> Measured with: `docker stats` during live job execution against demo.odoo.com

## Methodology

Each concurrency level was tested by submitting N jobs simultaneously with:
- `verificationMode: smoke`
- `maxSteps: 30`
- `maxScenarios: 5`
- Provider: OpenRouter / claude-haiku

Peak RSS was read from `docker stats --no-stream` at the moment all jobs were in the `exploring` phase (highest memory pressure — Chromium instances are all alive).

## Results

| MAX_CONCURRENT_JOBS | Peak backend RSS | Peak total (backend+redis+frontend) | Completed cleanly? |
|---|---|---|---|
| 1 | TBD | TBD | TBD |
| 2 | TBD | TBD | TBD |
| 3 | TBD | TBD | TBD |

> Fill this table by running:
> ```bash
> docker compose up -d
> # Submit N concurrent jobs via the UI or scripts/phase0-validate.sh
> docker stats --no-stream
> ```

## Recommendation

**Current default: `MAX_CONCURRENT_JOBS=2`** (set in `docker-compose.yml`)

Each Chromium instance (via Stagehand) uses approximately 300–500 MB RSS at peak. On a 16 GB machine with ~12 GB available to Docker:
- Concurrency 1: conservative, safe for 8 GB machines
- Concurrency 2: good balance — leaves headroom for OS and Redis
- Concurrency 3: feasible if no other heavy processes are running

Update the table above with measured numbers and adjust `docker-compose.yml` accordingly.
