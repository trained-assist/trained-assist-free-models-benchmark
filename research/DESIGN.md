# DESIGN — free/cheap model builds for trained-assist executor roles

Scope: which free/cheap OpenRouter builds can staff per-step executor roles
(`researcher` / `developer` / `reviewer` / `verifier`) without paying for Claude.
**Claude is out of scope — one cheap model tier everywhere.** Every number below
comes from `research/results.json` (produced by `research/run-bench.mjs`); no
claim is from memory.

## 1. Verifiable-first scoring

`research/bench-tasks.json` holds **8 tasks, 7 deterministic + 1 subjective**:

| check | tasks | how scored |
|---|---|---|
| `exact` | t01 (arith), t06 (python trace), t07 (find bug line) | parsed number == reference |
| `contains` | t03 (entity extraction) | all 5 reference strings present |
| `schema` | t02 (JSON extraction) | required keys + exact values |
| `test` | t04 (palindrome), t05 (fizzbuzz) | model code run against a hidden JS harness in `node:vm` (3s timeout) |
| `judge` | t08 (code review) | free-model LLM judge — **tagged `judge`, never mixed into the deterministic score** |

Deterministic tasks are the primary metric because a reference answer exists.
t08 has no fixed reference, so its verdict is `verdict_kind:"judge"` and is
reported separately everywhere in `results.json`.

## 2. Builds implemented (all in `run-bench.mjs`)

| build | what it is | what it measures |
|---|---|---|
| **B1** | single free model `nvidia/nemotron-3-ultra-550b-a55b:free` | baseline capability of one strong free model |
| **B2** | free ensemble over 5 **families** (nvidia, google, alibaba, inclusionai, cohere); each family falls over its own models; on disagreement **Hermes arbitrates** | whether cross-family diversity fixes single-model errors |
| **B3** | **Hermes critique loop**: Hermes frames challenge-questions → solver answers → Hermes critiques adversarially → solver revises | whether a self-critique loop adds correctness |
| **B4** | free-first chain (10 free models) → **cheap paid fallback** (deepseek-chat / gemini-flash-8b / gpt-4o-mini), hard cap $2 | reliability recovery + real cost of fallback |
| **B5** | single free stealth model `stealth/space-bunny-alpha` | evaluation of the brief's "Space Bunny Free" (see §6) |

Transient upstream failures (empty body, HTTP-200-with-empty-content, 429/403/5xx,
timeout) are retried up to `BENCH_RETRIES` (2 by default) — a real executor
retries. Every attempt is logged in `results.json → calls_log`; model-level
availability is measured separately by the probe (§5).

## 3. Headline benchmark results

Deterministic pass rate is the primary table (n=7). Judge task shown apart.

| build | deterministic | judge (tagged) | model invocations | tokens | wall latency | cost |
|---|---|---|---|---|---|---|
| B1 single free | **7/7 (1.00)** | 1/1 | 8 | 2,375 | 3 s | $0 |
| B2 ensemble + Hermes arbiter | **7/7 (1.00)** | 0/1 | 44 | 16,057 | 17 s | $0 |
| B3 Hermes critique loop | **6/7 (0.86)** | 0/1 | 31 | 28,368 | 20 s | $0 |
| B4 free→paid chain | **7/7 (1.00)** | 0/1 | 8 | 2,954 | 3 s | $0 |
| B5 Space Bunny | **7/7 (1.00)** | 0/1 | 8 | 2,511 | 7 s | $0 |

Paid fallback was **never reached** (`spend.json`: `total_usd: 0`, `paid_calls: 0`)
— the free chain answered every task on the first model. Cap $2 unused.

## 4. Did the Hermes critique loop (B3) beat the single model (B1)?

**No.** B3 scored 6/7 vs B1's 7/7 on the verifiable set, at ~6.7× the latency
and ~12× the tokens (28,368 vs 2,375). The one loss (t04-palindrome) is
instructive: the loop made 4 calls; the solver chain returned an empty answer
under the extra load, so the build ended with `error:"no answer produced"` and
`output:""`. More calls = more independent draws from a flaky free pool = a
higher chance the whole chain dead-ends. **A critique loop is not free**: it
multiplies both token cost and failure exposure.

## 5. Free-model availability is the real constraint (probe)

`results.json → model_probes` holds 2 snapshots of `PROBE_ATTEMPTS=3` trivial
calls per model (17 models), taken ~5 min apart. Aggregated:

| model | ok | failures |
|---|---|---|
| `inclusionai/ling-3.0-flash-sante:free` | 5/6 | 1×429 |
| `dots-studio/dots-3-note-preview:free` | 3/6 | 3×429 |
| `poolside/laguna-s-2.1:free` | 3/6 | 3×429 |
| `cohere/north-mini-code:free` | 3/6 | 3×429 |
| `nvidia/nemotron-3.5-lightning:free` | 2/6 | 3×429, 1×network |
| `nvidia/nemotron-3-ultra-550b-a55b:free` | 2/6 | 1×empty-200, 3×429 |
| `liquid/lfm-2.5-2.6b:free` | 1/6 | 5×429 |
| `inclusionai/ling-3.0-flash-fin:free` | 0/6 | 3× empty HTTP-200, 3×429 |
| `nvidia/nemotron-3.5-content-safety:free` | 0/6 | 3× empty HTTP-200, 3×429 |
| `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 0/6 | 3× empty HTTP-200, 3×429 |
| `poolside/laguna-xs-2.1:free` | 0/6 | 1×empty-200, 5×429 |
| `google/gemma-4-31b-it:free`, `gemma-4-26b-a4b-it:free` | 0/6 | **6×429** |
| `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` | 0/6 | 6×429 |
| `thinkingmachines/inkling:free`, `inkling-small:free` | 0/6 | **6×403** (dead) |

**Overall probe success rate: 19/102 = 18.6%** (mixed snapshot alone ≈ 33%).
Consequences:
- Most :free models are **not** a usable fleet. In the last snapshot only **7 of
  17** answered at all; **2 are permanently 403**, 2 Google models never left 429.
- A distinct, under-reported failure mode: **HTTP 200 with empty content** (no
  error, no text). `ling-fin`, `content-safety`, `nano-omni` did this on every
  attempt; `nemotron-ultra` did it once. A naive single call silently yields "".
- Availability is **time-varying** — the same model is 3/3 in one snapshot and
  0/3 minutes later. Builds must be resilient to this, not tuned to one model.

## 6. "Space Bunny Free"

Identified via `/api/v1/models`: **`stealth/space-bunny-alpha`** ("Space Bunny
Alpha", 1,000,000 ctx, pricing 0). No public model card ("stealth" = an
unlabelled model, likely a lab A/B test; treat data as potentially retained).
It scored **7/7 deterministic**, 0 build errors, 8 calls / 2,511 tokens. The
subjective-task judge call timed out, not the model. It is a viable single-model
baseline, with the caveat that its routing/retention is opaque.

## 7. Honest: where ensembles help / where they don't

All from `results.json`:

- **Help:** B2 (ensemble) recovered from the two hard-down families — google and
  alibaba both 429'd, so the ensemble ran on nvidia + inclusionai + cohere and
  still returned an answer for every task (`errors: 0`). On disagreement (4 of 8
  tasks: t02, t04, t05, t08) Hermes arbitration still landed 7/7 deterministic.
  Cross-family diversity is the mechanism that survives a dead provider.
- **Don't help (ceiling):** B1/B4/B5 already hit 7/7. The task set is too easy for
  a strong free model, so the ensemble had **no headroom to prove itself** — its
  only measured value here is availability, not accuracy.
- **Correlated errors / shared arbiter:** B2's arbiter and B4's first link are
  both `nemotron-ultra`, i.e. the same model as B1. When the arbiter itself is
  wrong or empty, the ensemble's fix is not independent. Family diversity only
  helps at the *member* level, not for the judge/arbiter.
- **Cost of loops:** B3 spent ~12× the tokens of B1 and scored *worse*, and its
  one failure was caused by the loop's own extra calls hitting the flaky pool.
  Loops buy correctness only when the base model is unreliable, and they pay for
  it in tokens, latency and dead-end risk.
- **Judge is untrustworthy on free models:** the subjective task's judge
  succeeded only 1 of 5 builds (B2/B3/B5 timed out or returned empty; B4
  unparsable). In several of those the *candidate answer was actually correct*
  (e.g. B2/B5 both named the leading-whitespace risk) yet scored `fail` because
  the judge flaked. **Do not gate cheap-profile steps on a free-model LLM judge.**
- **Sycophancy:** in B3 the solver revised toward whatever Hermes said; with no
  independent verifier, a wrong critique can drag a correct first answer off —
  the revision is only as good as the critique, which is itself a free model.

## 8. Packaging into `runDueDurable` executor roles

`src/playbook-executor.js` already resolves a step to `{engine, ocProfile,
ocRole}` via `DEFAULT_LEVEL_MAP` (bachelor→`opencode/value`, master→
`opencode/max`, doctor→`claude`) and `ROLE_TO_OC` (researcher→explore,
developer→build, reviewer/verifier→review). Claude is out of scope, so the
cheap profile is pinned with `PLAYBOOK_LEVEL_MAP` (e.g. bachelor → `opencode/free`)
and no step escalates to the doctor tier. Mapping:

| role | cheapest viable build | why (from results) |
|---|---|---|
| **researcher** (explore) | **B1/B5** single free model, or **B4** chain for guaranteed answer | cheap, long-ctx (nemotron-ultra & bunny = 1M ctx); 7/7 deterministic |
| **developer** (build) | **B1/B4** single free model with the free→paid chain | codegen tasks (t04/t05) pass; B4's chain absorbs the empty-200/429 drops |
| **reviewer** | **B2** cross-family ensemble + Hermes arbiter | disagreement signal (4/8 tasks) is the useful output; survives dead families |
| **verifier** | **B2** ensemble for deterministic checks; **no free judge** for subjective verdicts | free judge failed 4/5; use `programmatic` / `test` checks, not an LLM judge |

Concretely: a verifier step should be `execution_kind:"programmatic"` (harness/
test) — the one reliable free-path signal we have — and only fall back to an LLM
judge on a *paid* model. `runDueDurable` already threads `llmValidate` through
`src/playbook-validators.js`, so this is a config choice (`validation_mode`),
not new code.

## 9. Reproduce

```bash
export OPENROUTER_API_KEY=...
node research/run-bench.mjs --fresh                 # B1–B5, all tasks
BENCH_PROBE=1 BENCH_ONLY_PROBE=1 BENCH_RETRIES=1 PROBE_ATTEMPTS=3 \
  node research/run-bench.mjs                       # model availability probe
```

Outputs: `results.json` (per task×build: output, verdict, latency, tokens, cost,
calls_log, model_probes, summary) and `spend.json` (paid ledger, cap $2).
No file under `trained-assist-agent/` was modified.
