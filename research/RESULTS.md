# RESULTS — free/cheap model builds for trained-assist (opencode run)

Task: find free/cheap OpenRouter builds that can staff per-step executor roles
without paying for Claude, and back every claim with numbers. Claude is out of
scope — one cheap model tier everywhere. All data from `research/results.json`.

## Headline table (7 deterministic tasks; judge task tagged separately)

| build | deterministic | judge* | calls | tokens | latency | cost |
|---|---|---|---|---|---|---|
| **B1** single free (`nemotron-3-ultra-550b-a55b:free`) | **7/7** | 1/1 | 8 | 2,375 | 3 s | $0 |
| **B2** free ensemble (5 families) + Hermes arbiter | **7/7** | 0/1 | 44 | 16,057 | 17 s | $0 |
| **B3** Hermes critique loop (frame→solve→critique→revise) | **6/7** | 0/1 | 31 | 28,368 | 20 s | $0 |
| **B4** free→cheap-paid fallback chain (cap $2) | **7/7** | 0/1 | 8 | 2,954 | 3 s | $0 |
| **B5** single free `stealth/space-bunny-alpha` ("Space Bunny") | **7/7** | 0/1 | 8 | 2,511 | 7 s | $0 |

\* judge = free-model LLM verdict on the one subjective task; it is **never**
mixed into the deterministic score. Paid fallback was never reached — `$0` spent
of the `$2` cap (`spend.json`).

## Free-model availability (probe: 17 models × 3 attempts × 2 snapshots)

Overall **19/102 attempts = 18.6%** succeeded (`model_probes` in results.json).
Only ~7 of 17 answered in the last snapshot. Failures: 429 (shared-pool rate
limit), **403** (both `inkling` models — dead), and **HTTP-200 with empty
content** (`ling-fin`, `nano-omni`, `content-safety` — no error, no text).
Availability changes minute-to-minute; gemma/qwen/super never worked at all.

## Verdict (5 lines)

1. **A single strong free model is enough for the deterministic work** — B1/B5 hit 7/7, so the verifiable ceiling was reached without ensembles or loops.
2. **The bottleneck is availability, not accuracy** — ~81% of raw free calls fail (429/403/empty-200); only a chained build (B4) or a cross-family ensemble (B2) reliably survives it.
3. **The Hermes critique loop (B3) lost** — 6/7 vs 7/7, at ~12× tokens and ~5.9× latency; extra calls increase dead-ends more than they fix errors.
4. **Never gate a cheap-profile step on a free-model LLM judge** — it failed 4 of 5 builds, including cases where the candidate answer was actually correct.
5. **Cheap profile is viable today** if roles map to: researcher/developer = single free model or B4 chain; reviewer/verifier = B2 ensemble + `programmatic`/`test` checks (no LLM judge); Claude stays out of scope.

## Artifacts

- `research/BRIEF.md` — original brief
- `research/bench-tasks.json` — 8 tasks (7 deterministic, 1 judge)
- `research/run-bench.mjs` — harness (B1–B5, checks, cost guardrail, probe)
- `research/results.json` — per task×build output/verdict/latency/tokens/cost + `calls_log` + `model_probes` + `summary`
- `research/spend.json` — paid-call ledger (cap $2, spent $0)
- `research/DESIGN.md` — design, honest ensemble analysis, role packaging
- `research/RESULTS.md` — this file

Reproduce: `OPENROUTER_API_KEY=... node research/run-bench.mjs --fresh`.
No file under `trained-assist-agent/` was modified.
