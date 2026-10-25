# Tests

| Command | Action |
|---|---|
| `npm test` | Build `dist/` and run all 763 tests in 62 files in parallel |
| `bash tests/run-tests.sh` | Build `dist/` and run one file at a time |
| `node scripts/lock.mjs build coverage` | Enforce `100%` V8 line, branch, and function coverage on `dist/` |

## Architecture & Invariants

- `scripts/lock.mjs` serializes builds and runs; `tests/harness/global-setup.cjs` reaps leaked child PIDs.
- Each test binds ephemeral loopback ports (`tests/harness/sandbox.cjs`); `T_KEEP_BASES=1` routes by `x-orig-host`.
- Timers use `date-offset`, `clock-warp`, `long-timer-shim`, `until`, `gate`, and `idle` instead of real sleeps.
- `tests/security/image-budget.test.cjs` verifies `fileBytes` (`tests/image-budget.json`) and 4-layer count via `docker image save`.
- Tests titled `(pinned)` or `(pinned defect)` are tracked in `tests/expected-drift.json` (0 open, 55 closed) and verified by `tests/security/dead-code-secrets.test.cjs`.

## Coverage Map

| Band | Files |
|---|---|
| Boot | `security/boot-preheat`, `logic/boot-fallbacks`, `security/production-command` |
| Public & Supabase | `logic/upstream-routes-units`, `logic/upstream-routes-edges`, `logic/http-cache`, `logic/cache-layer`, `logic/lacatho-menu-fetch`, `logic/menu-pdf-parser`, `logic/menu-date`, `logic/request-timeout` |
| Print | `logic/print-client`, `logic/admin-routes-print-census` |
| Guards | `security/input-attacks`, `security/exposure`, `security/probes-boundaries` |
| Login & Sessions | `logic/session-manager`, `logic/login-session-reuse`, `logic/envless-boot`, `security/entry-preheat`, `security/session-state`, `security/session-isolation`, `security/session-constraints`, `security/probes-concurrency`, `security/probes-growth`, `security/seal-traffic`, `security/probes-student-isolation` |
| Warm & Cold Reads | `security/compressed-serving`, `logic/request-identity-flights`, `security/menu-registry`, `logic/page-parser`, `logic/aurion-parsing-edges`, `logic/documents-edges`, `logic/documents-walk`, `logic/documents-session`, `logic/regressions-parsing-planning`, `logic/entity-decode`, `security/ajax-default`, `security/menu-unfold-retry`, `security/leaf-partial`, `security/planning-serialization` |
| Palantir | `logic/palantir-harvest`, `logic/palantir-harvest-limits`, `logic/palantir-daemon`, `logic/palantir-selection-retry`, `logic/colles-login-names` |
| Hard States | `logic/error-responses`, `logic/flow-retry`, `logic/era-empty-menu`, `logic/localisation`, `logic/regressions-sessions-harvest`, `security/misleading-responses`, `security/sentry-scrubber`, `logic/envless-sentry` |
| Cross-Cutting | `logic/dead-code`, `logic/route-contracts`, `logic/route-contracts-refusals`, `logic/route-contracts-dev`, `security/dead-code-secrets`, `security/image-budget`, `security/static-analysis`, `security/transport-tls` |
