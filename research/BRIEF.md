# Research brief — free/cheap model builds for trained-assist (opencode run)

Goal: find what we can build from FREE OpenRouter models (+ Hermes) so per-step
executor roles get real diversity without paying for Claude. Deliver a runnable
benchmark harness + a design doc. Back every claim with results.json.

## Assets already on disk
- `research/tasks-raw.json` — {files, count:3621, tasks:[{src,text}]}. Real user prompts
  from Claude logs. Buckets: fix-bug 161, implement 211, explain 151, review 126, research 16.
- `research/openrouter-free-models.json` — 17 :free models with ctx (incl.
  `nvidia/nemotron-3-ultra-550b-a55b:free` ctx=1M).
- `OPENROUTER_API_KEY` is in env; account works.
- Reference for free→paid chain + discovery: `trained-assist-agent/scripts/pr-coherence-check.mjs`.
- Hermes single-call JSON: `trained-assist-agent/src/hermes-run.js`.

## DO THIS, IN ORDER (keep it small)

### Step 1 — pick a VERIFIABLE task subset (not all 3621)
Select 6–10 tasks where the correct answer is checkable deterministically. Good sources:
(a) prompts from tasks-raw.json that are self-contained code/extraction tasks; (b) known
fixes from `trained-assist-agent` git history (bug → commit); (c) synthetic-but-realistic
tasks with a fixed expected output (e.g. "extract these 5 fields from this text",
"write a function that does X — must pass this test", "find the bug in this snippet whose
fix is known"). Write them to `research/bench-tasks.json` as:
`{id, prompt, reference, check: "exact"|"contains"|"test"|"schema", meta}`.
State explicitly which are deterministic (reference exists) vs which will only get an LLM
judge. Deterministic ones are the primary metric.

### Step 2 — build the harness `research/run-bench.mjs`
Loads bench-tasks.json, runs each BUILD on each task, applies the check, writes
`research/results.json` (per task × build: output, verdict, latency, tokens, cost).
Builds to implement (start with 3, add if time):
  B1 single free model (e.g. nvidia/nemotron-3-ultra-550b-a55b:free)
  B2 free-model ENSEMBLE across DIFFERENT families (nemotron + gemma + qwen/ling) —
     N independent answers, Hermes arbitrates disagreement.
  B3 Hermes CRITIQUE LOOP: Hermes frames challenge-questions → a model answers/generates
     → Hermes critiques from another angle → model revises.
  B4 free→cheap-paid fallback chain with model discovery (only on error/quota).
Checks: exact/contains/schema/test as declared. For non-deterministic tasks use a cheap
LLM judge and TAG the verdict as `judge` (subjective), never mix with deterministic score.

### Step 3 — cost guardrail
Free first. Paid fallback hard-capped at $2 total. Log every paid call (model, tokens,
cost) into results.json + a running `research/spend.json`. Abort if cap hit. Use
`research/openrouter-free-models.json`; can also discover via `/api/v1/models`. Also
evaluate "Space Bunny Free" if you can identify what it is — otherwise note it as unknown.

### Step 4 — write `research/DESIGN.md`
- the builds and what each measures;
- deterministic-first scoring (why verifiable subset);
- Hermes-large-context angle for research/critique — did B3 beat B1 on verifiable tasks?
- honest section: **where ensembles help / where they don't** (sycophancy, same-family
  correlated errors, cost of loops). Base it on results.json numbers.
- packaging: how each build maps to playbook executor roles (researcher/developer/
  reviewer/verifier) so runDueDurable runs it on a cheap profile. Claude OUT OF SCOPE —
  one model tier everywhere.

### Step 5 — report + commit
`research/RESULTS.md` — human summary table + 5-line verdict. Commit all of research/.
Do NOT modify trained-assist-agent src. Final message: file paths + the headline numbers.

## Rules
- Every model claim backed by a number in results.json. No claims from memory.
- If a free model errors/produces empty — that IS a result, record it.
- Keep the first working version SMALL and runnable; expand only if it already runs.
