# Tests

One runner, `node --test`, no test dependency. 753 tests in 62 files (752 without Docker, 751 in CI mode), about 12 s on 20 cores.

| Lane | Folder | A green test means |
|---|---|---|
| logic | `tests/logic/` | the route or module keeps its contract |
| security | `tests/security/` | the observed behaviour (leak, coercion, exposure, growth, race) is measured faithfully, not that the risk is gone |

## Run

```bash
npm test                 # build dist/, then every file in parallel
bash tests/run-tests.sh  # same build, one file at a time
node --test --test-global-setup=tests/harness/global-setup.cjs tests/logic/http-cache.test.mjs   # one file, after a build
```

- `scripts/lock.mjs` builds `dist/` and lets one build or run use it at a time.
- Each file picks its own loopback ports, so files and parallel runs never collide.
- Apps start from `dist/index.js` and send no third-party request: `tests/harness/sandbox.cjs` points every upstream at the file's stub. `T_KEEP_BASES=1` keeps real hostnames and routes by `x-orig-host`.
- No credential, no vault, no Supabase write. `PALANTIR_DELAY_MS=0`.
- Time is never waited out: tests move the child clock (`date-offset`, `clock-warp`, `long-timer-shim`) or wait on an event (`until`, `gate`, `idle`).

## Docker image budget

`tests/security/image-budget.test.cjs` finds an engine itself: `T_DOCKER` if set, else native `docker`. It builds `mauria-api:budget` when the image is missing or its context hash changed (label `mauria.budget.context`): about 65 s cold, nothing when unchanged. It skips only when no engine answers. A base-image bump can move the image bytes past the 1 MiB tolerance: refresh `fileBytes` in `tests/image-budget.json`. In CI the test matrix (Node 22.13 and 25) leaves this file out of the run when `IMAGE` is unset, so it shows no skip; the `image` job sets `IMAGE`, so a missing image fails there.

The budget pins `fileBytes`, the regular files summed from `docker image save`, because `docker image inspect .Size` depends on the image store (containerd counts the compressed blobs too, about 50 MB more).

## Coverage

```bash
node scripts/lock.mjs build coverage
```

Node's built-in coverage (`--experimental-test-coverage`), no extra package. CI (Node 26) runs this step, which fails below 98 % lines of `dist/`. Measured: 99.60 % lines, 92.83 % branches, 21 s. It reports compiled JS, not `src/`: with `--enable-source-maps` the report aborts on dependency maps that point at unshipped sources, and tsc's helper lines at the top of `index.js` count as uncovered. App children stop on a closed stdin and write their coverage at exit. The sandbox rewrites upstream bases and strips boot warm-up without moving any byte offset, so every process maps to the same source lines.

## Exit safety

The suite runs without `--test-force-exit`, so a leaked handle fails its file instead of hiding.

- Each app child exits when its parent's stdin pipe closes.
- `tests/harness/global-setup.cjs` keeps a pid registry under `os.tmpdir()/mauria-pids-*`. Setup first kills children left by a runner killed from outside. Teardown kills any child still alive and fails the run with its pid and command line.

## Pinned defects

A test titled `(pinned)` or `(pinned defect)` passes while encoding a defect left unfixed on purpose. `tests/expected-drift.json` lists each one (60 open, 14 closed) with its reason and the fix that closes it. Fix the product and re-baseline the assertion in the same commit, then move the entry to `closed`. `tests/security/dead-code-secrets.test.cjs` checks the registry both ways. Pinned tests are never skipped.

A failing test is never bent to pass: fix the product, or show the test is wrong and announce the test fix.

## What the files cover

How the 62 test files (`37` in `tests/logic/`, `25` in `tests/security/`) map to the ten coloured flows in `README.md` and the cross-cutting checks.

| Flow claim | Test |
|---|---|
| Boot fans out one upstream pass per source (13 calls) | `security/boot-preheat` |
| Concurrent cold CROUS misses share one fetch | `logic/upstream-routes-units` |
| Bad or oversized bodies stop before upstream | `security/input-attacks`, `security/exposure`, `logic/boot-fallbacks` |
| Login preheats grades, planning, absences, documents | `security/entry-preheat`, `security/session-state` |
| A cached answer is served as stored bytes, gzip only to a client that accepts it | `security/compressed-serving` |
| Identical concurrent requests share one run | `logic/documents-edges`, `security/probes-concurrency` |
| A walk that rides a registry menu id and is refused pays the unfold once, then retries | `security/menu-unfold-retry` |
| Keeper skips while 16+ upstream requests run | `logic/regressions-sessions-harvest` |
| A lost session costs one login and one retry | `security/session-state`, `security/menu-registry`, `logic/flow-retry` |
| A partial documents walk is answered, never cached | `logic/documents-edges`, `logic/documents-walk` |
| An outage reads unknown, not all fine | `security/misleading-responses` |
| One print login per account, kept 10 min | `logic/print-client`, `security/probes-concurrency`, `security/probes-growth` |
| A Supabase hang answers 502 within 15 s | `logic/request-timeout` |
| Palantir publish checks the token before the body is read | `logic/palantir-harvest-limits` |
| 4xx sends nothing to Sentry; one event per failure kind per window | `security/sentry-scrubber` |
| A sealed token resumes after a restart | `security/seal-traffic`, `logic/envless-boot` |

| `README.md` band | Files |
|---|---|
| Boot | `security/boot-preheat`, `logic/boot-fallbacks`, `security/production-command` |
| Public and Supabase read | `logic/upstream-routes-units`, `logic/upstream-routes-edges`, `logic/http-cache`, `logic/cache-layer`, `logic/lacatho-menu-fetch`, `logic/menu-pdf-parser`, `logic/menu-date`, `logic/request-timeout` |
| Print | `logic/print-client`, `logic/admin-routes-print-census` |
| Guards | `security/input-attacks`, `security/exposure`, `security/probes-boundaries` |
| Login | `logic/session-manager`, `logic/login-session-reuse`, `logic/envless-boot`, `security/entry-preheat`, `security/session-state`, `security/session-isolation`, `security/session-constraints`, `security/probes-concurrency`, `security/probes-growth`, `security/seal-traffic`, `security/probes-student-isolation` |
| Warm read | `security/compressed-serving` |
| Cold 2nd | `logic/request-identity-flights`, `security/menu-registry` |
| Cold 1st | `logic/page-parser`, `logic/aurion-parsing-edges`, `logic/documents-edges`, `logic/documents-walk`, `logic/documents-session`, `logic/regressions-parsing-planning`, `logic/entity-decode`, `security/ajax-default`, `security/menu-unfold-retry`, `security/leaf-partial`, `security/planning-serialization` |
| Palantir | `logic/palantir-harvest`, `logic/palantir-harvest-limits`, `logic/palantir-daemon`, `logic/palantir-selection-retry`, `logic/colles-login-names` |
| Hard states | `logic/error-responses`, `logic/flow-retry`, `logic/era-empty-menu`, `logic/localisation`, `logic/regressions-sessions-harvest`, `security/misleading-responses`, `security/sentry-scrubber`, `logic/envless-sentry` |
| Cross-cutting | `logic/dead-code`, `logic/route-contracts`, `logic/route-contracts-refusals`, `logic/route-contracts-dev`, `security/dead-code-secrets`, `security/image-budget`, `security/static-analysis`, `security/transport-tls` |
