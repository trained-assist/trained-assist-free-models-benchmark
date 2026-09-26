// probe-opencode-free.mjs — availability + real-work probe for the FREE models inside
// the opencode subscription (OpenCode Zen + OpenCode Go).
//
// WHY THIS METHOD AND NOT HTTP: the free tier only works from within the opencode client
// (a direct POST to /zen/... returns FreeTierError "can only be used from within
// OpenCode"). So every call shells out to `opencode run -m <provider>/<model>` — the same
// path the real agent uses. This is slower per call but it is the only correct signal.
//
// Phase 1: ping each model 3x  -> alive?
// Phase 2: every alive model gets the 3 medium inputs from data/avg-inputs.json -> usable?
//
// Usage:  node scripts/probe-opencode-free.mjs [--models m1,m2] [--probe-attempts 3]
import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';

const ROOT = new URL('..', import.meta.url).pathname;
const MODELS_PATH = ROOT + 'data/opencode-free-models.json';
const INPUTS_PATH = ROOT + 'data/avg-inputs.json';
const OUT_PATH = ROOT + 'results/opencode-probe.json';

const OPENCODE = process.env.OPENCODE_BIN || `${homedir()}/.opencode/bin/opencode`;

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const PROBE_ATTEMPTS = parseInt(opt('probe-attempts', '3'), 10);
const only = opt('models', '') ? opt('models').split(',') : null;

const all = JSON.parse(readFileSync(MODELS_PATH, 'utf8')).models;
const models = only ? all.filter(m => only.includes(m.id)) : all;
const inputs = JSON.parse(readFileSync(INPUTS_PATH, 'utf8')).inputs;

// Run one prompt through the real opencode client. Returns {ok, text, error}.
// NOTE: opencode run drives a full agent, so it may print tool chatter / inspect the
// working dir. We only treat a run as failed on a real process failure or an opencode
// error envelope ("ref": "err_..."), never because the output merely contains the word
// "error" (the model output frequently discusses errors).
function runModel(provider, model, prompt, timeoutMs = 120000) {
  const ref = `${provider}/${model}`;
  const t0 = Date.now();
  try {
    const out = execFileSync(OPENCODE, ['run', '-m', ref, prompt], {
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const hardError = /"ref":\s*"err_/.test(out) && !/[.\n]/.test(out.replace(/[\s\S]*"ref":\s*"err_[^"]*"[^}]*}[\s\S]*/, 'x'));
    const text = out.split('\n').filter(l => !/^>\s/.test(l)).join('\n').trim();
    return { ok: !!text && !hardError, text, error: hardError ? out.slice(0, 300) : null, latency_ms: Date.now() - t0 };
  } catch (e) {
    return {
      ok: false,
      text: (e.stdout || '').toString(),
      error: (e.stderr || e.message || '').toString().slice(0, 300),
      latency_ms: Date.now() - t0,
    };
  }
}

// Deterministic "usable" shape check (mirrors the real-work criteria).
function judge(input, text) {
  if (!text || !text.trim()) return { usable: false, why: 'empty' };
  if (input.kind === 'agentic') {
    const numbered = /(^|\n)\s*\d+[.)]/.test(text);
    return { usable: numbered, why: numbered ? 'numbered-plan' : 'no-numbered-list' };
  }
  const code = /```(js|javascript)/i.test(text) || /\bfunction\b/.test(text);
  return { usable: code, why: code ? 'code-shape' : 'no-code-shape' };
}

const results = [];
for (const m of models) {
  const probes = [];
  for (let a = 0; a < PROBE_ATTEMPTS; a++) {
    const r = runModel(m.provider, m.id, 'Reply with the single word: OK', 60000);
    probes.push({ ok: r.ok, error: r.error, latency_ms: r.latency_ms });
  }
  const alive = probes.some(p => p.ok);
  const probeOk = probes.filter(p => p.ok).length;

  const ins = [];
  if (alive) {
    for (const inp of inputs) {
      const r = runModel(m.provider, m.id, inp.text, 180000);
      const v = r.ok ? judge(inp, r.text) : { usable: false, why: r.error ? 'exec-error' : 'empty' };
      ins.push({ input_id: inp.id, kind: inp.kind, ok: r.ok, usable: v.usable, why: v.why, latency_ms: r.latency_ms, chars: (r.text || '').length, error: r.error || null });
    }
  }
  const usable = ins.filter(i => i.usable).length;
  const survived = alive && ins.length === inputs.length && usable === inputs.length;
  results.push({
    id: m.id, provider: m.provider, ctx: m.ctx, reasoning: m.reasoning,
    probe_ok: probeOk, probe_attempts: PROBE_ATTEMPTS, alive, inputs: ins,
    usable_count: usable, survived_all: survived,
  });
  const flag = survived ? 'SURVIVED' : alive ? 'partial' : 'DEAD';
  console.error(`[probe] ${m.provider}/${m.id} ${flag} probe=${probeOk}/${PROBE_ATTEMPTS} usable=${usable}/${ins.length}`);
}

const alive = results.filter(r => r.alive).length;
const survived = results.filter(r => r.survived_all).length;
const summary = {
  source: 'opencode-zen+go', generated_at: new Date().toISOString(),
  totals: {
    total: results.length, alive, alive_pct: +(alive / results.length * 100).toFixed(1),
    survived_all_3: survived, survived_pct_of_total: +(survived / results.length * 100).toFixed(1),
    survived_pct_of_alive: alive ? +(survived / alive * 100).toFixed(1) : 0,
  },
  models: results,
};
writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
console.error('\n== SUMMARY ==\n' + JSON.stringify(summary.totals, null, 1));
