# trained-assist-free-models-benchmark

**GCP VM exit (05.10.2026):** New work on `alesa-personal-assistent/us-central1-a/alesa-vm` is prohibited. Use serverless by default; the existing French VM only for a proven persistent or local requirement. Other Google services remain allowed. See [the exit plan](https://github.com/trained-assist/trained-agent-architecture/issues/145).


**Tracking issue: [#2 — Benchmark: free models for real auto-fix](https://github.com/trained-assist/trained-assist-free-models-benchmark/issues/2)** (goal, checklist, open questions).

Which **free** model can actually do the job? The job we care about is **auto-fix**:
take a repository whose PR/CI is failing and fix the code until CI is green. That is what
`trained-assist-agent/src/issue-fixer.js` does in production, and it is the primary
consumer of whatever this benchmark selects. "Sometimes answers" is not good enough — we
need a model that reliably gets to a green CI.

## Why free models are not all equal (findings so far)

- **OpenRouter free** (17 models): shared, publicly rate-limited pool. A direct-HTTP probe
  gave 11/17 answering and 4/17 surviving 3 real inputs. (An earlier "19%" figure was a
  probe bug — tiny `max_tokens` truncating reasoning models; the probe was fixed.)
- **OpenCode Zen + Go free** (35 models): this is a **subscription pool, not a shared
  rate-limited one**, so availability is structurally different. But the free tier
  **only works from inside the opencode client** — a direct HTTP request returns
  `FreeTierError: can only be used from within OpenCode`. So the only correct way to
  measure (and to run at all) is `opencode run -m <provider>/<model>`.
- **Consequence:** the foundation should be **opencode-free (Zen/Go)**. OpenRouter free is
  at most a far fallback rung, never the base.

## Continuous bench of our LLM API

`scripts/ladder-bench.mjs` benchmarks the **trained-assist-llm-ladder** worker
(`https://llm-ladder.trainedassist.store`) — the API every trained-assist service call and
pr-autofix go through. Every rung of every ladder is pinned via `ladder_rung` (no failover), then
each ladder runs as clients see it; tasks = ping, JSON mode, a tool call, plus the 3 inputs in
`data/avg-inputs.json`. Quality (#5), not just shape: the two code tasks are **executed**
(temp file, `node`, 6s cap) against the cases the prompt promises — a keyword mention no longer
passes; `agent-plan` is graded by an LLM judge (rung-pinned `opencode-go/mimo-v2.6-flash`,
rubric = the task's `expect`) → `q0–2` in the cell. Every rung row carries a tier icon
(💚 free / 💛 subscription / 🔴 paid) with a per-tier rollup on top. A run is red when a ladder
fails ping/JSON as a client would see it. `.github/workflows/ladder-bench.yml` runs it every
6 hours (and on demand) and posts the table to issue #3. Provider keys stay in the worker — the
bench only needs `LLM_LADDER_TOKEN` (org secret).

```bash
LLM_LADDER_TOKEN=... node scripts/ladder-bench.mjs [--quick] [--ladders deepseek,free]
```

## Layout

```
scripts/
  extract-tasks.mjs        # (helper) pull real user prompts from ~/.claude session logs
  probe-opencode-free.mjs  # availability + 3 medium inputs, via `opencode run`
  realworld.mjs            # SKELETON: failing-PR -> model fix -> green CI, with anti-cheat scoring
data/
  opencode-free-models.json  # the 35 free models in Zen+Go (id, provider, ctx, reasoning)
  free-models.json           # the 17 OpenRouter free models + benchmarks
  avg-inputs.json            # 3 medium inputs (code-fix / code-gen / agent-plan) + shape rules
  or-models.json             # OpenRouter catalog snapshot
results/                     # script output (JSON)
```

`ctx` in `opencode-free-models.json` is **measured live**, not copied from docs: a prompt of
~N tokens is sent straight to zen with the validated fingerprint and the server's own cap is
read back (`zen-limit-probe.mjs --fill-tokens`, trained-assist-llm-ladder#106). Values as of
2026-10-03: `mimo-v2.6-flash-free` / `mimo-v2.5-free` = 1 048 576, `nemotron-3.5-lightning-free`
= 1 000 000. `big-pickle` is **not stable** — it load-balances across backends with caps
262 139 and ≥1M, so the file stores the guaranteed floor (262 139), not the best case.

Legacy exploratory scripts and the first (superseded) benchmark live under `research/`
(kept for provenance — see `research/RESULTS.md`).

## Run

```bash
# availability + real-work probe over all opencode-free models (slow: spawns the client)
node scripts/probe-opencode-free.mjs

# subset only, fewer attempts (fast iteration)
node scripts/probe-opencode-free.mjs --models big-pickle,space-bunny-free --probe-attempts 1
```

Reads the opencode auth (`~/.local/share/opencode/auth.json`) automatically; needs the
`opencode` binary (override with `OPENCODE_BIN`).

## The real-world benchmark (issue #1)

`scripts/realworld.mjs` is the older scaffold for cloning public failing PRs. The **primary**
benchmark we run now is `scripts/autofix-bench.mjs` — a faithful copy of the production
pipeline in `trained-assist-agent/src/issue-fixer.js` (clone → engine → verify, up to 3
attempts), with the issue replaced by a case that has **known-failing tests**.

### Corpus — from our own history, depth-scaled

`scripts/find-cases.mjs` builds `data/cases.json` deterministically:

1. take a `fix(...)`/`feat(...)` commit from the agent repo that touched BOTH `src/` and
   test files;
2. in an **isolated worktree** (never touches `main`) stage the state *before* the fix
   (`<sha>~1`) → this is the red state;
3. run the tests that commit touched → count failures;
4. bucket by depth and keep a **quota of 10**: `2` cases with ≥3 failing tests, `3` with
   exactly 2, `5` with exactly 1;
5. clean the worktree up.

Why our own history and not random public PRs: a random red PR is usually red for reasons
a model should not be scored on (flaky test, missing secret, infra). Reverting a real fix
gives a **guaranteed reproducible red state with a known failing test** — no ground-truth
fix needed, the failing test IS the target.

### Run

```bash
node scripts/find-cases.mjs                     # build data/cases.json (quota 2/3/5)
node scripts/autofix-bench.mjs --model opencode/space-bunny-free
```

`autofix-bench.mjs` — simple launch, deep analytics:
- per case: `for attempt 1..3 { model fixes → run the case's tests }`;
- records **green/failing counts after each attempt** (depth / progress / first-pass) and
  residual failure **kinds** (assertion / structural / timeout);
- **anti-cheat**: test files must be untouched, diff non-empty, no `|| true` / `.skip` /
  `eslint-disable` / `@ts-ignore`;
- writes the final diff of every case to `results/diff-*.patch` for **expert review**
  (a Claude pass over the diffs for gross code smells — bypasses, hardcoded test values,
  disabled checks, dead code, goto-like control flow). It is a subjective layer, kept
  separate from the deterministic metric.

Success = tests green **and** cheat-free.


## The architect role (Hermes critique loop)

A secondary experiment (not auto-fix): can a **critique loop** — Hermes frames
challenge-questions → a model produces → Hermes critiques from another angle → the model
revises — beat a single call on design/architecture tasks where there is no code to run?
This is the one place free models are used for reasoning rather than code, so it is scored
by shape + an LLM judge (labelled subjective, never mixed with deterministic scores).

## Rules

- Every claim backed by a number in `results/` — no claims from memory.
- Free tier only for the base; any paid fallback is hard-capped and logged.
- A free model that errors or returns empty **is a result**, not a reason to skip it.
