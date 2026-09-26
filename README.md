# trained-assist-free-models-benchmark

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

`scripts/realworld.mjs` is the scaffold for the experiment that actually decides this:

1. **Corpus of failing PRs** (`data/corpus.json`) where the failure is **code-caused**,
   not flaky/infra. A failing CI is not automatically a fixable task — a flaky test, a
   missing secret, or someone else's broken dependency are not things a model should be
   scored on. Collect ~30–50 such items; not 100 blind ones.
   Shape: `[{ id, repo, baseSha, branch, cloneUrl, verifyCmd, taskPath }]`.
2. **Isolated run**: clone at the failing state, run `opencode run -m <model>` in the
   clone (same path as production `issue-fixer`).
3. **Score with anti-cheat** — a green CI alone is not a win. Success requires ALL of:
   - CI is green;
   - the diff is non-empty;
   - **no test files modified**;
   - no obvious bypass (`|| true`, `.skip`, deleted asserts).
4. **Clean up**: remove the workspace; delete the fork if one was created.

TODO in the skeleton (marked in code): populate the corpus, and optionally open a
fork+PR on a subsample so **real GitHub CI** decides instead of a local `verifyCmd`.

### Local vs GitHub CI

- **Local** (`npm ci && npm run check && npm test`) mirrors what `issue-fixer` runs in
  production: fast, cheap, no forks. **Default.**
- **GitHub fork + PR**: only for a subsample, when real CI semantics matter. Delete the
  fork afterwards.

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
