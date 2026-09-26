# Research brief — cheap/free model ensembles for the trained-assist agent

Owner delegated this ("доверься тебе"). Produce a **design + a runnable benchmark harness**
that answers: *what can we build out of free/cheap OpenRouter models + Hermes, and how do
we package it so per-step executor roles get real diversity without paying for Claude.*

## Context / assets already prepared
- `research/tasks-raw.json` — 3 621 deduped real user prompts extracted from
  `~/.claude/projects` (Claude session logs). Fields: `{src, text}`. Buckets: fix-bug 161,
  implement 211, explain 151, review 126, research 16 (rest "other").
- `research/openrouter-free-models.json` — the 17 `:free` models on this account with
  context length (incl. `nvidia/nemotron-3-ultra-550b-a55b:free` ctx=1M).
- OpenRouter key is in env (`OPENROUTER_API_KEY`); the account works (HTTP 200).
- Existing reference implementation of a free→paid model chain with discovery:
  `trained-assist-agent/scripts/pr-coherence-check.mjs`.
- Hermes single-call JSON: `trained-assist-agent/src/hermes-run.js` (`hermesRun({task,context,outputSchema})`).
- Space Bunny Free is another free provider worth evaluating (find out what it actually is).

## What to design
1. **Builds (3–5, pick after testing feasibility)** combining:
   - single free model,
   - free-model **ensemble / self-consistency** across *different families* (nemotron,
     gemma, qwen, ling, poolside…) + Hermes as arbiter,
   - **Hermes critique loop**: Hermes frames challenge-questions → a model produces →
     Hermes critiques from another angle → model revises,
   - free→cheap-paid fallback chain with autosuggest (`/api/v1/models`) on error/quota.
2. **A scoring approach that is deterministic first**: pick a small set of tasks whose
   correct answer we can verify by exact/structural checks (e.g. a bug whose fix is known,
   an extraction with a known schema, code that must pass a given test). Use a **reference
   answer** (from the logs / known-good PR) — measure correctness, not vibes. Fall back to
   a cheap-LLM judge only where no reference exists; state clearly which tasks are which.
3. **The Hermes angle**: evaluate Hermes' large context for the *research/critique* role —
   does critique-loop actually raise correctness on the verifiable tasks vs a single call?
4. **Packaging**: how this maps onto playbook per-step executor roles (`researcher`,
   `developer`, `reviewer`, `verifier`) — concretely, what a step's `instructions`/config
   would say so `runDueDurable` runs the ensemble/loop on a cheap profile (Claude out of
   scope for now: one model tier everywhere).

## Budget
- Prefer free models. Allow a **hard-capped** cheap-paid fallback (cap total spend ≤ $2).
- Log every paid call (model, tokens, cost). Abort the run if the cap is hit.

## Deliverables (must exist on disk)
1. `playbooks/` or `research/` **runnable harness** (node scripts) that: loads a task set,
   runs each build, applies deterministic checks, writes `research/results.json` +
   a markdown report `research/RESULTS.md`.
2. `research/DESIGN.md` — the design: builds, scoring, when paid fallback, packaging into
   playbook roles, and an honest "where ensembles help / where they don't" section.
3. Commit both, open a PR against `main` in this repo (`trained-assist/trained-assist-engineering`
   is a sibling, but this bench repo is standalone). If pushing isn't possible, write the
   files and report the local paths.

## Rules
- Do **not** modify `trained-assist-agent` src. This is research in this repo.
- Every claim about model behaviour backed by `research/results.json`, not memory.
- If a free model is unusable (errors/empty), record that as a result — it's signal.
